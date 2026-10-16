// tests/bundle-compose-gate.test.js
//
// Our own bundles must pass our own install security check. The check
// (validateComposeFile in servers/gateway/routes/bundles.js) runs on every
// install; eight first-party bundles were refused by it for months because no
// test ran it over the real compose files. This file does, for EVERY tracked
// bundle, plus unit cases for the rules that changed with it:
//   - exactly the read-only /etc/localtime mount is allowed from /etc;
//   - quoted `network_mode: "host"`, `privileged: True`, `cap_add: [ALL]`, long-syntax
//     `source:` mounts and a second compose file are caught;
//   - a community-origin bundle never gets privileged powers.
// The check reads compose files as TEXT, comments included: netdata's comment named a
// blocked capability, so the comment was reworded rather than the check weakened.
// It also refuses a first-party port published on every interface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _validateComposeFileForTest as validate } from "../servers/gateway/routes/bundles.js";
import { trackedBundleSet } from "../scripts/build-registry.mjs";
import { parseComposeHostPorts } from "../servers/gateway/port-inventory.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// Bundles we EXPECT the gate to refuse even with consent. Each entry needs a
// reason a reviewer can check. Keep it empty: a first-party bundle that cannot
// be installed should be fixed or removed, not listed here.
const EXPECTED_REFUSALS = {};

// First-party ports deliberately published on every interface.
const ALL_INTERFACE_BINDS = {
  caddy: { reason: "public reverse proxy for federated bundles: it must answer 80/443 from the internet", ports: ["80", "443", "443/udp"] },
};

function trackedComposeBundles() {
  const tracked = trackedBundleSet();
  assert.ok(tracked && tracked.size > 0, "git ls-files found no tracked bundles");
  return [...tracked]
    .filter((id) => existsSync(join(REPO, "bundles", id, "docker-compose.yml")))
    .sort()
    .map((id) => ({
      id,
      composePath: join(REPO, "bundles", id, "docker-compose.yml"),
      manifest: JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8")),
    }));
}

const requiresConsent = (m) => m?.privileged === true || m?.consent_required === true;

test("every tracked first-party compose passes the install security check (with its manifest + consent)", () => {
  const bundles = trackedComposeBundles();
  assert.ok(bundles.length >= 60, `expected the full bundle set, got ${bundles.length}`);
  const refused = [];
  for (const b of bundles) {
    const r = validate(b.composePath, b.id, { manifest: b.manifest, consentVerified: true });
    if (r.valid && EXPECTED_REFUSALS[b.id]) refused.push(`${b.id}: listed in EXPECTED_REFUSALS but now passes; remove the entry`);
    if (!r.valid && !EXPECTED_REFUSALS[b.id]) refused.push(`${b.id}: ${r.reason}`);
  }
  assert.deepEqual(refused, [], `install security check refuses first-party bundles:\n  ${refused.join("\n  ")}`);
});

test("a bundle whose compose needs consent declares it, refuses without it, and explains it in English and Spanish", () => {
  const problems = [];
  for (const b of trackedComposeBundles()) {
    if (EXPECTED_REFUSALS[b.id]) continue;
    const bare = { ...b.manifest, privileged: false, consent_required: false };
    const needs = !validate(b.composePath, b.id, { manifest: bare, consentVerified: true }).valid;
    if (!needs) continue;
    if (!requiresConsent(b.manifest)) problems.push(`${b.id}: compose needs consent, manifest declares neither privileged nor consent_required`);
    if (validate(b.composePath, b.id, { manifest: b.manifest, consentVerified: false }).valid) problems.push(`${b.id}: passes WITHOUT consent`);
    const msgs = b.manifest.install_consent_messages || {};
    if (!(msgs.en || "").trim() || !(msgs.es || "").trim()) problems.push(`${b.id}: install_consent_messages needs en + es`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

// Binds that name an env var with no default are allowed only for model bundles: their
// .env (written by the Model Catalog) supplies the tailnet address. Anything else binds a
// literal address or a ${VAR:-literal} default; unset, a bare ${VAR} binds every interface.
const TEMPLATE_BIND_OK = (m) => m.inference === true;

/** `ports:` items as the shared parser walks them, to catch entries it would drop. */
function rawPortItems(text) {
  const out = [];
  let inPorts = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    if (/^\s*ports:\s*$/.test(line)) { inPorts = true; continue; }
    if (!inPorts) continue;
    if (/^\s*-/.test(line)) { out.push(line.trim()); continue; }
    if (line.trim()) inPorts = false;
  }
  return out;
}

test("no first-party bundle publishes a port on every interface", () => {
  const bad = [];
  for (const b of trackedComposeBundles()) {
    const text = readFileSync(b.composePath, "utf8");
    if (/^\s*ports:\s*\[/m.test(text) || /^\s*-?\s*published:/m.test(text)) {
      bad.push(`${b.id}: inline or long-syntax ports; write "- 127.0.0.1:HOST:CONTAINER" so they can be checked`);
    }
    const parsed = parseComposeHostPorts(text);
    const items = rawPortItems(text);
    if (parsed.length !== items.length) bad.push(`${b.id}: a port entry the checker cannot read (${items.join(" | ")})`);
    const allowed = ALL_INTERFACE_BINDS[b.id];
    for (const p of parsed) {
      if (p.bindKind === "loopback" || p.bindKind === "specific") continue;
      if (p.bindKind === "template" && TEMPLATE_BIND_OK(b.manifest)) continue;
      const hp = `${p.port}${p.proto === "udp" ? "/udp" : ""}`;
      if (p.bindKind === "all" && allowed && allowed.ports.includes(hp)) continue;
      bad.push(`${b.id}: port ${hp} binds ${p.bindKind === "template" ? `${p.bind} (every interface when unset)` : "every interface"}`);
    }
  }
  assert.deepEqual(bad, [], `ports published on all interfaces:\n  ${bad.join("\n  ")}`);
});

test("the port check reads the shapes our composes use", () => {
  const text = [
    "services:", "  a:", "    ports:", "      # comment",
    '      - "127.0.0.1:8080:80"', "      - 9000:9000", '      - "${X_PORT:-3005}:3005"',
    '      - "127.0.0.1:${Y_PORT:-8088}:8080"', '      - "8555:8555/udp"', '      - "${CROW_TAILSCALE_IP}:8003:8000"',
    '      - "0.0.0.0:443:443/udp"     # HTTP/3', "      - 7000",
  ].join("\n");
  assert.deepEqual(parseComposeHostPorts(text).map((p) => p.bindKind), ["loopback", "all", "all", "loopback", "all", "template", "all"]);
  assert.equal(rawPortItems(text).length, 8, "the bare '- 7000' is seen by the raw walk, so the count check catches the parser dropping it");
});

// ---- gate unit cases -------------------------------------------------------

function gate(yaml, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-gate-"));
  try {
    const p = join(dir, "docker-compose.yml");
    writeFileSync(p, yaml);
    return validate(p, "fx", opts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const svc = (body) => `services:\n  app:\n    image: busybox\n${body}`;
const PRIV = { manifest: { privileged: true }, consentVerified: true };

test("comments still count: the check reads the file as text", () => {
  assert.equal(gate(svc("    # cap_add: [SYS_PTRACE]\n")).valid, false);
  assert.equal(gate(svc("    cap_add: [NET_RAW] # trailing\n")).valid, false);
  assert.equal(gate(svc("    privileged: true\n")).valid, false);
  for (const v of ["True", "TRUE", '"true"']) assert.equal(gate(svc(`    privileged: ${v}\n`)).valid, false, v);
  assert.equal(gate(svc('    "privileged": true\n')).valid, false, "quoted key");
});

test("cap_add ALL is a dangerous capability; cap_drop ALL is not", () => {
  assert.equal(gate(svc("    cap_add: [ALL]\n")).valid, false);
  assert.equal(gate(svc("    cap_add:\n      - ALL\n")).valid, false);
  assert.equal(gate(svc("    cap_add: [ALL]\n"), PRIV).valid, true);
  assert.equal(gate(svc("    cap_drop: [ALL]\n")).valid, true);
});

test("exactly the read-only /etc/localtime mount is allowed from /etc", () => {
  for (const ok of [
    "      - /etc/localtime:/etc/localtime:ro\n",
    '      - "/etc/localtime:/etc/localtime:ro"\n',
    "      - '/etc/localtime:/etc/localtime:ro'\n",
    "      - /etc/localtime:/etc/localtime:ro   # trailing comment\n",
    "      - /etc/localtime:/etc/localtime:ro\n      - ./data:/data\n",
    "      - /etc/localtime:/etc/localtime:ro\n    environment:\n      - A=1\n",
  ]) {
    assert.equal(gate(svc(`    volumes:\n${ok}`)).valid, true, ok);
  }
  for (const bad of [
    "      - /etc/localtime:/etc/localtime\n",
    "      - /etc/localtime:/etc/localtime:rw\n",
    "      - /etc/localtime:/x:ro\n",
    "      - /etc/timezone:/etc/timezone:ro\n",
    "      - /etc/passwd:/etc/passwd:ro\n",
    "      - /etc:/host-etc:ro\n",
    "      - /etc/localtime/../shadow:/etc/localtime:ro\n",
    "      - /etc/localtime:/etc/localtime:ro,z\n",
    "      - /etc/localtime:/etc/localtime:ro#,rw\n",
    "      - /etc/localtime:/etc/localtime:ro\n        ,rw\n",
    "      - /etc/localtimex:/etc/localtimex:ro\n",
    "      - /etc/localtime:/etc/localtime:ro\n      - /etc/shadow:/s:ro\n",
  ]) {
    assert.equal(gate(svc(`    volumes:\n${bad}`)).valid, false, bad);
  }
});

test("a second compose file next to docker-compose.yml is refused (Compose would use it unchecked)", () => {
  for (const f of ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.override.yml", "compose.override.yaml"]) {
    const dir = mkdtempSync(join(tmpdir(), "crow-gate-"));
    try {
      writeFileSync(join(dir, "docker-compose.yml"), svc(""));
      writeFileSync(join(dir, f), svc("    privileged: true\n"));
      assert.equal(validate(join(dir, "docker-compose.yml"), "fx", PRIV).valid, false, f);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("a community-origin bundle never gets privileged powers, even with consent", () => {
  const community = { manifest: { privileged: true, origin: "community" }, consentVerified: true };
  assert.equal(gate(svc("    network_mode: host\n"), community).valid, false);
  assert.equal(gate(svc("    cap_add: [NET_ADMIN]\n"), community).valid, false);
  assert.equal(gate(svc("    network_mode: host\n"), PRIV).valid, true);
});

test("quoted host networking is caught; privileged + consent still allows it", () => {
  for (const v of ['"host"', "'host'", "host"]) {
    assert.equal(gate(svc(`    network_mode: ${v}\n`)).valid, false, v);
    assert.equal(gate(svc(`    network_mode: ${v}\n`), PRIV).valid, true, v);
  }
  assert.equal(gate(svc("    network_mode: bridge\n")).valid, true);
});

test("long-syntax volume sources are held to the same sensitive-path rule", () => {
  for (const src of ["/etc", '"/etc/shadow"', "/", "'/'", "~/.ssh", "~/.ssh/id_rsa", "~/.crow/data"]) {
    const y = svc(`    volumes:\n      - type: bind\n        source: ${src}\n        target: /x\n`);
    assert.equal(gate(y).valid, false, src);
    assert.equal(gate(y, PRIV).valid, false, `${src} is refused even with privileged + consent`);
  }
  assert.equal(gate(svc("    volumes:\n      - type: bind\n        source: ./data\n        target: /x\n")).valid, true);
  assert.equal(gate(svc("    volumes:\n      - type: bind\n        source: /etc/localtime\n        target: /etc/localtime\n        read_only: true\n")).valid, false,
    "long-syntax timezone mounts are not allowlisted (short syntax only)");
});

test("the four host-network bundles are privileged and explain it in English and Spanish", () => {
  for (const id of ["companion", "coturn", "plex", "tailscale"]) {
    const m = JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));
    assert.equal(m.privileged, true, `${id} must be privileged (host networking)`);
    assert.ok(/host network/i.test(m.install_consent_messages?.en || ""), `${id}: English consent text must name host networking`);
    assert.ok((m.install_consent_messages?.es || "").length > 40, `${id}: Spanish consent text missing`);
  }
});

// ---- review round 2: ways to make Compose run config the check never read ----------

function gateDir(files, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-gate-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return validate(join(dir, "docker-compose.yml"), "fx", opts);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("COMPOSE_* settings in the bundle's .env/.env.example (Compose reads them: COMPOSE_FILE swaps the file) are refused", () => {
  for (const name of [".env", ".env.example"]) {
    for (const line of ["COMPOSE_FILE=evil.yml", "  COMPOSE_FILE = evil.yml", "export COMPOSE_FILE=evil.yml", "COMPOSE_PATH_SEPARATOR=;", "COMPOSE_PROFILES=x"]) {
      assert.equal(gateDir({ "docker-compose.yml": svc(""), [name]: `A=1\n${line}\n` }, PRIV).valid, false, `${name}: ${line}`);
    }
  }
  assert.equal(gateDir({ "docker-compose.yml": svc(""), ".env.example": "# COMPOSE_FILE is not used\nA=1\n" }).valid, true);
});

test("include: and extends: file: pull in config the check never read", () => {
  assert.equal(gate(`include:\n  - other.yml\n${svc("")}`, PRIV).valid, false);
  assert.equal(gate(`include: [other.yml]\n${svc("")}`, PRIV).valid, false);
  assert.equal(gate(svc("    extends:\n      file: other.yml\n      service: x\n"), PRIV).valid, false);
  assert.equal(gate(svc("    extends: { file: other.yml, service: x }\n"), PRIV).valid, false);
  assert.equal(gate(svc("    extends:\n      service: base\n")).valid, true, "extends within the same file is fine");
});

test("host files outside the bundle can't be read in through env_file, secrets/configs file:, or the build context", () => {
  for (const body of [
    "    env_file: /home/u/.crow/.env\n",
    "    env_file:\n      - ../../.env\n",
    "    env_file:\n      - ~/.crow/.env\n",
    "    env_file:\n      - path: /etc/shadow\n",
    "    build:\n      context: /\n",
    "    build: /etc\n",
    "    build:\n      context: ../..\n",
    "    build: ~/\n",
  ]) {
    assert.equal(gate(svc(body), PRIV).valid, false, body);
  }
  assert.equal(gate(`${svc("")}secrets:\n  s:\n    file: /etc/shadow\n`, PRIV).valid, false);
  assert.equal(gate(`${svc("")}configs:\n  c:\n    file: ../../data/crow.db\n`, PRIV).valid, false);
  for (const ok of ["    env_file: .env\n", "    env_file:\n      - ./app.env\n", "    build: .\n", "    build:\n      context: ./renderer\n"]) {
    assert.equal(gate(svc(ok)).valid, true, ok);
  }
  assert.equal(gate(`${svc("")}secrets:\n  s:\n    file: ./secret.txt\n`).valid, true);
});

test("a mount source that climbs out of the bundle dir with .. is refused (../../data is the Crow data dir)", () => {
  for (const v of ["      - ../../data:/d\n", "      - ./../../data:/d:ro\n", '      - "../x:/x"\n', "      - ${X:-.}/../../data:/d\n"]) {
    assert.equal(gate(svc(`    volumes:\n${v}`), PRIV).valid, false, v);
  }
  assert.equal(gate(svc("    volumes:\n      - type: bind\n        source: ../../data\n        target: /d\n"), PRIV).valid, false);
  assert.equal(gate(svc("    volumes:\n      - ./data..old:/d\n")).valid, true, "a name containing .. is not a parent step");
});

test("sharing another container's network, or the host's PID/user namespace, needs privileged + consent", () => {
  for (const body of ["    network_mode: container:crow-browser\n", '    network_mode: "container:abc"\n', "    pid: host\n", '    pid: "host"\n', "    pid: container:x\n", "    userns_mode: host\n"]) {
    assert.equal(gate(svc(body)).valid, false, body);
    assert.equal(gate(svc(body), PRIV).valid, true, body);
  }
  assert.equal(gate(svc("    network_mode: service:db\n")).valid, true, "service: is a service in the same, checked file");
});

test("install and Configure refuse COMPOSE_* / DOCKER_* keys (they would steer Docker Compose itself)", async () => {
  const { findInvalidEnv } = await import("../servers/gateway/routes/bundles.js");
  for (const k of ["COMPOSE_FILE", "COMPOSE_PROFILES", "DOCKER_HOST"]) {
    assert.equal(findInvalidEnv({ [k]: "x" })?.key, k, k);
  }
  assert.equal(findInvalidEnv({ MY_COMPOSE_FILE: "x", A: "1" }), null);
  assert.equal(findInvalidEnv({ COMPOSE_PROJECT_NAME: "browser-r4" }), null, "a co-hosted instance names its project (the model check holds the name to the bundle)");
});

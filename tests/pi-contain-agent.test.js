// Task 4 (S2a contain): the GENERATED pi agent dir a contained spawn gets.
// File/JSON assertions only — no bwrap runs here (tests/pi-contain.test.js
// runs real sandboxes).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { buildContainedAgentDir, containedCloudTokenPath } from "../scripts/pi-bots/pi_contain_agent.mjs";
import { buildContainPlan, ContainRefused } from "../scripts/pi-bots/pi_contain.mjs";
import { wrapPiSpawn } from "../scripts/pi-bots/pi_sandbox.mjs";
import { llmCloudTokenPath } from "../servers/gateway/local-token.js";
import { normalizeBaseUrl } from "../servers/shared/provider-presets.js";

const T = realpathSync(mkdtempSync(join(tmpdir(), "crow-contain-agent-")));
const PORT = 3199;
const SALT = "a".repeat(64);
const CLOUD_KEY = "consent-checked-cloud-key";
const saved = { bots: process.env.CROW_PI_CONTAIN_BOTS };
after(() => {
  if (saved.bots === undefined) delete process.env.CROW_PI_CONTAIN_BOTS;
  else process.env.CROW_PI_CONTAIN_BOTS = saved.bots;
  rmSync(T, { recursive: true, force: true });
});

const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };

const crowHome = mk(T, "crowhome");
const cloudTokenPath = join(crowHome, "llm-cloud-token");
writeFileSync(cloudTokenPath, "cloud-door-token-value", { mode: 0o600 });
const dataDir = mk(crowHome, "data");
writeFileSync(join(dataDir, "crow.db"), "");
const rolesFile = join(crowHome, "model-roles.json");
writeFileSync(rolesFile, JSON.stringify({ roles: { everyday: "local-chat/m1" } }));

// The operator's agent dir: everything in it that must NOT reach a contained bot.
const piAgentDir = mk(T, "agent");
writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["pkg/pi-lab"], theme: "night" }));
writeFileSync(join(piAgentDir, "keybindings.json"), JSON.stringify({ "ctrl+k": "search" }));
writeFileSync(join(piAgentDir, "auth.json"), JSON.stringify({ openai: { key: "operator-login" } }));
writeFileSync(join(piAgentDir, "models-store.json"), JSON.stringify({ providers: {} }));
writeFileSync(join(piAgentDir, "models.json"), JSON.stringify({
  providers: { hand: { baseUrl: "http://192.168.200.9:1/v1", apiKey: "hand-written-literal", models: [{ id: "m" }] } },
}));
writeFileSync(join(piAgentDir, "mcp.json"), JSON.stringify({
  mcpServers: { board: { url: "http://127.0.0.1:3001/board/mcp", headers: { Authorization: "Bearer board-literal" } } },
}));
mk(piAgentDir, "pkg", "pi-lab");
mk(piAgentDir, "skills", "lab-maintenance");
const outside = mk(T, "outside");
writeFileSync(join(outside, "secret.txt"), "x");
symlinkSync(join(outside, "secret.txt"), join(piAgentDir, "linked.json"));

const rows = [
  // a bundle row on a LAN address: the provider door forwards for it
  { id: "local-chat", baseUrl: "http://192.168.1.9:8011/v1", apiKey: "provider-literal-key", bundleId: "vllm-x",
    provider_type: "openai-compat", models: [{ id: "m1", contextWindow: 8192 }], gpuPolicy: null, disabled: false },
  { id: "native-owned", baseUrl: "http://127.0.0.1:18100/v1", apiKey: null, bundleId: null,
    provider_type: "openai-compat", models: [{ id: "m2" }], gpuPolicy: { runtime: "native" }, disabled: false },
  { id: "external-engine", baseUrl: "http://192.168.1.10:8022/v1", apiKey: "none", bundleId: null,
    provider_type: "openai-compat", models: [{ id: "m3" }], gpuPolicy: { engine: { managed: "external", host: "lab" } }, disabled: false },
  { id: "Cloud Max", baseUrl: "https://cloud.example.com/v1", apiKey: CLOUD_KEY, bundleId: null,
    provider_type: "openai-compat", models: [{ id: "c1" }], gpuPolicy: null, disabled: false },
  // a plain LAN endpoint no door serves (doorKindOf: "unmanaged")
  { id: "lan-plain", baseUrl: "http://192.168.1.11:8033/v1", apiKey: "none", bundleId: null,
    provider_type: "openai-compat", models: [{ id: "l1" }], gpuPolicy: null, disabled: false },
];
const cloudRow = rows.find((r) => r.id === "Cloud Max");
const consent = {
  [cloudRow.id]: {
    target: normalizeBaseUrl(cloudRow.baseUrl),
    keyFp: createHmac("sha256", Buffer.from(SALT, "hex")).update(CLOUD_KEY.trim()).digest("hex").slice(0, 16),
    at: "2026-11-02T00:00:00Z",
    by: "operator",
  },
};
const NEEDED = ["local-chat", "native-owned", "external-engine", "Cloud Max", "crow-c-Cloud Max"];

function build(over = {}) {
  const dir = mkdtempSync(join(T, "dir-"));
  const res = buildContainedAgentDir({
    piAgentDir, dir, providerIds: NEEDED, rows, consent, consentSalt: SALT,
    gatewayPort: PORT, cloudTokenPath, modelRolesFile: rolesFile, ...over,
  });
  return { dir, res };
}

test("models.json is door-only: /llm/p for a served row, the consented /llm/c door for a cloud row, no literal key", () => {
  const { dir, res } = build();
  assert.deepEqual(res.missing, []);
  const raw = readFileSync(join(dir, "models.json"), "utf8");
  const models = JSON.parse(raw);
  assert.deepEqual(Object.keys(models.providers).sort(),
    ["crow-c-Cloud Max", "external-engine", "local-chat", "native-owned"].sort());
  const doorRe = new RegExp("^http://127\\.0\\.0\\.1:" + PORT + "/llm/(p|c)/");
  for (const [id, e] of Object.entries(models.providers)) {
    assert.match(e.baseUrl, doorRe, id + " points at this gateway's door");
    if (e.baseUrl.includes("/llm/c/")) {
      assert.match(e.apiKey, /^!cat '.*'$/, id + " reads its key from the door token file");
      assert.ok(e.apiKey.includes(cloudTokenPath), id + " names the cloud-door token");
    } else {
      assert.equal(e.apiKey, "none", id + " carries no key: the gateway holds the row's");
    }
    assert.ok(Array.isArray(e.models) && e.models.length, id + " has models");
  }
  assert.equal(models.providers["local-chat"].baseUrl, `http://127.0.0.1:${PORT}/llm/p/local-chat/v1`);
  assert.equal(models.providers["external-engine"].baseUrl, `http://127.0.0.1:${PORT}/llm/p/external-engine/v1`);
  assert.equal(models.providers["Cloud Max"], undefined, "a cloud row is reachable only as its consented door entry");
  assert.equal(models.providers["lan-plain"], undefined);
  assert.ok(!raw.includes("provider-literal-key"), "the row's key never lands in the file");
  assert.ok(!raw.includes(CLOUD_KEY), "the cloud key never lands in the file");
  assert.ok(!raw.includes("http://192.168."), "no LAN address lands in the file");
});

test("no auth.json, no models-store.json, and mcp.json is exactly an empty server map", () => {
  const { dir } = build();
  assert.equal(existsSync(join(dir, "auth.json")), false, "the operator's pi logins never reach a contained bot");
  assert.equal(existsSync(join(dir, "models-store.json")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")), { mcpServers: {} },
    "the bot's servers arrive on the MCP config fd, not from this file");
  const models = readFileSync(join(dir, "models.json"), "utf8");
  assert.ok(!models.includes("192.168.200.9"), "the operator's own models.json entries are not copied");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).packages, ["pkg/pi-lab"],
    "settings.json is copied: pi loads its packages[] gate from it");
  assert.match(readFileSync(join(dir, "keybindings.json"), "utf8"), /ctrl\+k/);
});

test("no inherited skills, and no symlink anywhere in the dir resolves outside it", () => {
  const { dir } = build();
  assert.equal(existsSync(join(dir, "skills")), false, "the operator's skills/ is not an entry");
  assert.ok(!readdirSync(dir).includes("linked.json"), "a symlink in the operator's dir is not copied");
  const offenders = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        let target = null;
        try { target = realpathSync(p); } catch { target = null; }
        if (!target || (target !== dir && !target.startsWith(dir + sep))) offenders.push(p);
      } else if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], "every symlink stays inside the dir");
});

test("a needed provider with no door is reported, and wrapPiSpawn refuses the contain spawn", () => {
  // a literal-key cloud row this box never consented to
  const noConsent = build({ providerIds: ["Cloud Max"], consent: {} }).res;
  assert.deepEqual(noConsent.missing, [{ provider: "Cloud Max", reason: "provider Cloud Max has no door" }]);
  // a LAN row /llm/p does not serve
  const lan = build({ providerIds: ["lan-plain"] }).res;
  assert.deepEqual(lan.missing, [{ provider: "lan-plain", reason: "provider lan-plain has no door" }]);
  // a provider id no row matches (not "a row with no model list")
  assert.equal(build({ providerIds: ["unknown-provider"] }).res.missing[0].reason, "provider unknown-provider has no door");

  process.env.CROW_PI_CONTAIN_BOTS = "contain-door-bot";
  const contain = {
    home: T, crowHome, dataDir,
    sessionDir: mk(T, "session"), cwd: join(T, "session"),
    missing: lan.missing,
  };
  const probe = { ok: true, pidns: true, bwrap: "/usr/bin/bwrap", reason: null, pidnsReason: null };
  assert.throws(() => wrapPiSpawn(process.execPath, ["--version"], { botId: "contain-door-bot", contain, probe }),
    (e) => e instanceof ContainRefused && e.message === "contain refused: provider lan-plain has no door");
});

test("the role snapshot is copied inside the dir, 0600, and named by the spawn env", () => {
  const { dir, res } = build();
  const p = res.env.CROW_MODEL_ROLES_FILE;
  assert.ok(p.startsWith(dir + sep), p + " lives inside the generated dir");
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), JSON.parse(readFileSync(rolesFile, "utf8")));
  assert.equal(res.roleSnapshotPath, p);

  // no snapshot yet: the env still names a path inside the dir, never <CROW_HOME>
  const bare = build({ modelRolesFile: join(crowHome, "no-such-roles.json") }).res;
  assert.equal(bare.roleSnapshotPath, null);
  assert.ok(bare.env.CROW_MODEL_ROLES_FILE.startsWith(bare.dir + sep));
  assert.equal(existsSync(bare.env.CROW_MODEL_ROLES_FILE), false);
});

test("the contain plan binds the cloud-door token file alone, read-only", () => {
  const args = buildContainPlan({ home: T, crowHome, dataDir, cloudTokenPath, sessionDir: mk(T, "session"), cwd: join(T, "session") }).args;
  const i = args.indexOf(cloudTokenPath); // the bind's source: `--ro-bind <src> <dst>`
  assert.ok(i > 0, "the token file is bound");
  assert.equal(args[i - 1], "--ro-bind");
  assert.equal(args[i + 1], cloudTokenPath);
  const binds = [];
  for (let k = 0; k < args.length; k++) if (args[k] === "--bind" || args[k] === "--ro-bind") { binds.push([args[k], args[k + 1]]); k += 2; }
  assert.ok(!binds.some(([flag, src]) => flag === "--bind" && src === crowHome), "the Crow home is not a read-write bind");
  assert.ok(!binds.some(([flag, src]) => flag === "--bind" && src === join(crowHome, "secrets")));
});

test("the cloud-door token path matches the gateway's own llmCloudTokenPath()", () => {
  assert.equal(containedCloudTokenPath(), llmCloudTokenPath());
});

test("a source settings.json that is itself a symlink is copied by content, never as a link out", () => {
  const dotfiles = mk(T, "dotfiles");
  writeFileSync(join(dotfiles, "settings.json"), JSON.stringify({ packages: ["pkg/pi-lab"], theme: "linked" }));
  const agent2 = mk(T, "agent-linked");
  symlinkSync(join(dotfiles, "settings.json"), join(agent2, "settings.json"));
  const dir = mkdtempSync(join(T, "dir-linked-"));
  buildContainedAgentDir({ piAgentDir: agent2, dir, providerIds: ["local-chat"], rows, gatewayPort: PORT,
    cloudTokenPath, modelRolesFile: rolesFile });

  const out = join(dir, "settings.json");
  assert.equal(lstatSync(out).isSymbolicLink(), false, "copied as a regular file, not as a link");
  assert.equal(readFileSync(out, "utf8"), readFileSync(join(dotfiles, "settings.json"), "utf8"), "the target's content");
  assert.equal(statSync(out).mode & 0o777, 0o600);
  // The same invariant as the walk above: nothing in the dir links out.
  const offenders = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (!lstatSync(p).isSymbolicLink()) continue;
    let target = null;
    try { target = realpathSync(p); } catch { target = null; }
    if (!target || (target !== dir && !target.startsWith(dir + sep))) offenders.push(p);
  }
  assert.deepEqual(offenders, [], "no symlink leaves the generated dir");
});

test("the cloud-door token is bound only when a consented /llm/c entry was generated", () => {
  // No cloud model in the generated models.json: no token, no bind.
  const plain = build({ providerIds: ["local-chat"] }).res;
  assert.equal(plain.cloudTokenPath, null, "nothing reads a token without a /llm/c entry");
  const noToken = buildContainPlan({ home: T, crowHome, dataDir, cloudTokenPath: plain.cloudTokenPath,
    sessionDir: mk(T, "session-plain"), cwd: join(T, "session-plain") }).args;
  assert.ok(!noToken.includes(cloudTokenPath), "the token file is not bound");

  // A consented cloud row: the resolved token path comes back for the bind.
  const withCloud = build().res;
  assert.equal(withCloud.cloudTokenPath, realpathSync(cloudTokenPath));
  const bound = buildContainPlan({ home: T, crowHome, dataDir, cloudTokenPath: withCloud.cloudTokenPath,
    sessionDir: mk(T, "session-cloud"), cwd: join(T, "session-cloud") }).args;
  const i = bound.indexOf(withCloud.cloudTokenPath);
  assert.ok(i > 0 && bound[i - 1] === "--ro-bind" && bound[i + 1] === withCloud.cloudTokenPath, "bound read-only, same path");
});

test("a symlinked CROW_HOME: the bound token and the !cat path are the same resolved file", () => {
  const realHome = mk(T, "tokenhome-real");
  const token = join(realHome, "llm-cloud-token");
  writeFileSync(token, "cloud-door-token-value", { mode: 0o600 });
  const linkHome = join(T, "tokenhome-link");
  symlinkSync(realHome, linkHome);

  const { dir, res } = build({ cloudTokenPath: join(linkHome, "llm-cloud-token") });
  const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
  const entry = models.providers["crow-c-Cloud Max"];
  assert.ok(entry, "the consented cloud row is present");
  assert.ok(entry.apiKey.includes(token), "the !cat apiKey names the RESOLVED file: " + entry.apiKey);
  assert.ok(!entry.apiKey.includes(linkHome), "never the link the caller passed");
  assert.equal(res.cloudTokenPath, token);

  const session = mk(T, "session-link");
  const args = buildContainPlan({ home: T, crowHome, dataDir, cloudTokenPath: res.cloudTokenPath,
    sessionDir: session, cwd: session }).args;
  const i = args.indexOf(res.cloudTokenPath);
  assert.ok(i > 0 && args[i - 1] === "--ro-bind", "the bound source is that same resolved file");
});
test("a cloud token swapped for a symlink is never bound (it would expose whatever it points at)", async () => {
  const { cloudTokenFile } = await import("../scripts/pi-bots/pi_contain_agent.mjs");
  const { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const D = realpathSync(mkdtempSync(join(tmpdir(), "contain-token-")));
  mkdirSync(join(D, "home")); mkdirSync(join(D, "elsewhere"));
  writeFileSync(join(D, "elsewhere", "id_key"), "secret");
  symlinkSync(join(D, "elsewhere", "id_key"), join(D, "home", "llm-cloud-token"));
  assert.equal(cloudTokenFile(join(D, "home", "llm-cloud-token")), null, "a symlinked token file is refused");
  writeFileSync(join(D, "home", "real-token"), "t");
  assert.equal(cloudTokenFile(join(D, "home", "real-token")), join(D, "home", "real-token"));
  symlinkSync(join(D, "home"), join(D, "home-link"));
  assert.equal(cloudTokenFile(join(D, "home-link", "real-token")), join(D, "home", "real-token"), "a symlinked Crow home still resolves to the real file");
  assert.equal(cloudTokenFile(join(D, "home", "missing")), null);
});

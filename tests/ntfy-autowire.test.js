/**
 * ntfy autowire (spec docs/superpowers/specs/2026-10-03-ntfy-autowire-design.md).
 * Hermetic: a fake `docker exec … ntfy` runner, a loopback HTTP stand-in for ntfy,
 * and temp CROW_DATA_DIRs. Never touches a real container.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import express from "express";

import {
  resolveNtfyConfig, readStoredNtfyConfig, writeStoredNtfyConfig, readNtfyStatus,
  ntfyConfigPath, normalizeExternalUrl,
} from "../servers/gateway/push/ntfy-config.js";
import {
  provisionNtfy, autowireAtBoot, instanceKey, parseUsers, parseTokens, installedBundleIds,
} from "../servers/gateway/push/ntfy-provision.js";

const ID_A = "0867ac2809dedd885ba7769b21966f8e";
const ID_B = "c22c6af81c13ff920ce609d2d61d8065";

function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), "ntfy-aw-"));
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  return { home: dir, data, env: { CROW_HOME: dir, CROW_DATA_DIR: data } };
}

/**
 * A fake ntfy server CLI behind `docker exec crow-ntfy ntfy …`. Shares state across
 * instances (one server, several Crow homes) like the real co-hosted case.
 */
function fakeNtfy({ running = true, authFile = true, notStartedFor = 0 } = {}) {
  const state = { users: new Set(), acl: [], tokens: new Map(), calls: [], notStartedFor, n: 0 };
  const runner = async (cmd, args, opts = {}) => {
    state.calls.push({ cmd, args: [...args], env: opts.env });
    assert.equal(cmd, "docker");
    if (args[0] === "inspect") {
      if (!running) throw Object.assign(new Error("exit 1"), { stderr: "Error: No such object: crow-ntfy" });
      return { stdout: "true\n", stderr: "" };
    }
    assert.equal(args[0], "exec");
    const i = args.indexOf("crow-ntfy");
    assert.ok(i > 0, "exec targets the crow-ntfy container");
    assert.equal(args[i + 1], "ntfy");
    const [sub, ...rest] = args.slice(i + 2);
    if (!authFile) throw Object.assign(new Error("exit 1"), { stderr: "option auth-file not set; auth is unconfigured for this server" });
    if (state.notStartedFor > 0) {
      state.notStartedFor--;
      throw Object.assign(new Error("exit 1"), { stderr: "auth-file does not exist; please start the server at least once to create it" });
    }
    if (sub === "user" && rest[0] === "list") {
      let out = "";
      for (const u of state.users) out += `user ${u} (role: user, tier: none)\n- no topic-specific permissions\n`;
      out += "user * (role: anonymous, tier: none)\n- no access to any (other) topics (server config)\n";
      return { stdout: out, stderr: "" };
    }
    if (sub === "user" && rest[0] === "add") {
      const name = rest[1];
      assert.ok(args.includes("-e") && args[args.indexOf("-e") + 1] === "NTFY_PASSWORD", "password passed by env name only");
      assert.ok(opts.env?.NTFY_PASSWORD?.length >= 20, "a random password is in the docker CLI env");
      if (state.users.has(name)) throw Object.assign(new Error("exit 1"), { stderr: `user ${name} already exists` });
      state.users.add(name);
      return { stdout: `user ${name} added with role user\n`, stderr: "" };
    }
    if (sub === "access") {
      state.acl.push(rest.join(" "));
      return { stdout: "granted\n", stderr: "" };
    }
    if (sub === "token" && rest[0] === "list") {
      const toks = state.tokens.get(rest[1]) || [];
      if (!toks.length) return { stdout: `user ${rest[1]} has no access tokens\n`, stderr: "" };
      return { stdout: `user ${rest[1]}\n${toks.map((tk) => `- ${tk} (crow-autowire), never expires`).join("\n")}\n`, stderr: "" };
    }
    if (sub === "token" && rest[0] === "add") {
      const user = rest[rest.length - 1];
      assert.ok(rest.includes("--label=crow-autowire"));
      const tk = `tk_${user.replace(/[^a-z0-9]/g, "")}${++state.n}`;
      state.tokens.set(user, [...(state.tokens.get(user) || []), tk]);
      return { stdout: `token ${tk} created for user ${user}, never expires\n`, stderr: "" };
    }
    throw new Error(`unexpected ntfy call: ${args.join(" ")}`);
  };
  return { state, runner };
}

const noSleep = async () => {};

// ─── config resolution ───

test("env mode is unchanged: topic, extras, token, and URL derivation from the gateway URL", () => {
  const { env } = tmpData();
  Object.assign(env, { NTFY_TOPIC: "kevin", NTFY_EXTRA_TOPICS: "kevin-mpa, kevin ,kevin-mpa,", NTFY_AUTH_TOKEN: "tk_env", CROW_GATEWAY_URL: "https://crow.example.ts.net:8444" });
  const c = resolveNtfyConfig(env);
  assert.equal(c.source, "env");
  assert.deepEqual(c.topics, ["kevin", "kevin-mpa"]);
  assert.equal(c.publishToken, "tk_env");
  assert.equal(c.subscriberToken, "tk_env", "env hosts keep handing NTFY_AUTH_TOKEN to apps");
  assert.equal(c.externalUrl, "https://crow.example.ts.net:2586");
  assert.equal(c.publishHost, "localhost");
  assert.equal(c.publishPort, "2586");
  assert.equal(resolveNtfyConfig({ ...env, NTFY_SUBSCRIBER_TOKEN: "tk_ro" }).subscriberToken, "tk_ro");
  assert.equal(resolveNtfyConfig({ ...env, NTFY_EXTERNAL_URL: "https://n.example:8445" }).externalUrl, "https://n.example:8445");
  // A stored auto config never shadows env.
  writeStoredNtfyConfig({ topic: "crow-x", publisherToken: "tk_p", subscriberToken: "tk_s" }, env);
  assert.equal(resolveNtfyConfig(env).topic, "kevin");
});

test("auto mode reads ntfy-push.json; env fields override; nothing configured → null", () => {
  const { env } = tmpData();
  assert.equal(resolveNtfyConfig(env), null);
  writeStoredNtfyConfig({ topic: "crow-0867ac2809", publisherToken: "tk_pub", subscriberToken: "tk_app", host: "localhost", port: 2586, externalUrl: "https://crow.example.ts.net:8445" }, env);
  assert.equal(statSync(ntfyConfigPath(env)).mode & 0o777, 0o600);
  let c = resolveNtfyConfig(env);
  assert.equal(c.source, "auto");
  assert.equal(c.publishToken, "tk_pub");
  assert.equal(c.subscriberToken, "tk_app");
  assert.equal(c.externalUrl, "https://crow.example.ts.net:8445");
  c = resolveNtfyConfig({ ...env, NTFY_EXTERNAL_URL: "https://override:1", NTFY_PORT: "9999", NTFY_EXTRA_TOPICS: "other" });
  assert.equal(c.externalUrl, "https://override:1");
  assert.equal(c.publishPort, "9999");
  assert.deepEqual(c.topics, ["crow-0867ac2809", "other"]);
  // No stored address and no gateway URL → no phone address (route answers disabled).
  writeStoredNtfyConfig({ topic: "crow-0867ac2809", publisherToken: "a", subscriberToken: "b", externalUrl: "" }, env);
  assert.equal(resolveNtfyConfig(env).externalUrl, null);
  assert.equal(resolveNtfyConfig({ ...env, CROW_GATEWAY_URL: "https://g.example:8444" }).externalUrl, "https://g.example:2586");
  // A corrupt file is "not configured", not a crash.
  writeFileSync(ntfyConfigPath(env), "{not json");
  assert.equal(resolveNtfyConfig(env), null);
});

test("normalizeExternalUrl accepts http(s) origins/paths only", () => {
  assert.equal(normalizeExternalUrl(" https://h.ts.net:8445/ "), "https://h.ts.net:8445");
  assert.equal(normalizeExternalUrl(""), "");
  assert.equal(normalizeExternalUrl("javascript:alert(1)"), null);
  assert.equal(normalizeExternalUrl("https://u:p@h"), null);
  assert.equal(normalizeExternalUrl("https://h/?x=1"), null);
  assert.equal(normalizeExternalUrl("not a url"), null);
});

// ─── provisioning ───

test("instance key + parsers", () => {
  assert.equal(instanceKey(ID_A), "crow-0867ac2809");
  assert.throws(() => instanceKey(""), /instance id/);
  assert.deepEqual([...parseUsers("user a-pub (role: user, tier: none)\nuser * (role: anonymous, tier: none)\n")], ["a-pub"]);
  assert.deepEqual([...parseTokens("- tk_abc123 (x), never expires\n")], ["tk_abc123"]);
});

test("first run creates two users, a private topic ACL and two tokens; the config file is 0600", async () => {
  const { env } = tmpData();
  const { state, runner } = fakeNtfy();
  const r = await provisionNtfy({ runner, env, instanceId: ID_A, sleep: noSleep });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.topic, "crow-0867ac2809");
  assert.deepEqual([...state.users].sort(), ["crow-0867ac2809-app", "crow-0867ac2809-pub"]);
  assert.deepEqual(state.acl, [
    "crow-0867ac2809-pub crow-0867ac2809 write-only",
    "crow-0867ac2809-app crow-0867ac2809 read-only",
    "everyone crow-0867ac2809 deny",
  ]);
  const c = readStoredNtfyConfig(env);
  assert.equal(c.publisherToken, state.tokens.get("crow-0867ac2809-pub")[0]);
  assert.equal(c.subscriberToken, state.tokens.get("crow-0867ac2809-app")[0]);
  assert.notEqual(c.publisherToken, c.subscriberToken);
  assert.equal(statSync(ntfyConfigPath(env)).mode & 0o777, 0o600);
  // No password ever reaches argv.
  for (const call of state.calls) for (const a of call.args) assert.ok(!a.includes(call.env?.NTFY_PASSWORD || "\u0000"), "password not in argv");
});

test("re-running is idempotent: no new users or tokens, the address setting survives", async () => {
  const { env } = tmpData();
  const { state, runner } = fakeNtfy();
  assert.equal((await provisionNtfy({ runner, env, instanceId: ID_A, sleep: noSleep })).ok, true);
  writeStoredNtfyConfig({ ...readStoredNtfyConfig(env), externalUrl: "https://crow.example:8445" }, env);
  const before = readStoredNtfyConfig(env);
  const r = await provisionNtfy({ runner, env, instanceId: ID_A, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.deepEqual(r.created, { users: [], tokens: [] });
  const after = readStoredNtfyConfig(env);
  assert.equal(after.publisherToken, before.publisherToken);
  assert.equal(after.subscriberToken, before.subscriberToken);
  assert.equal(after.externalUrl, "https://crow.example:8445");
  assert.equal(after.provisionedAt, before.provisionedAt);
  assert.equal(state.tokens.get("crow-0867ac2809-pub").length, 1);
});

test("concurrent provisioning of one instance is single-flight (one token pair)", async () => {
  const { env } = tmpData();
  const { state, runner } = fakeNtfy();
  const [a, b] = await Promise.all([
    provisionNtfy({ runner, env, instanceId: ID_A, sleep: noSleep }),
    provisionNtfy({ runner, env, instanceId: ID_A, sleep: noSleep }),
  ]);
  assert.equal(a, b);
  assert.equal(state.tokens.get("crow-0867ac2809-pub").length, 1);
});

test("a token the server no longer knows is re-minted", async () => {
  const { env } = tmpData();
  const { state, runner } = fakeNtfy();
  await provisionNtfy({ runner, env, instanceId: ID_A, sleep: noSleep });
  state.tokens.set("crow-0867ac2809-app", []); // operator revoked it / volume recreated
  const r = await provisionNtfy({ runner, env, instanceId: ID_A, sleep: noSleep });
  assert.deepEqual(r.created.tokens, ["crow-0867ac2809-app"]);
  assert.equal(readStoredNtfyConfig(env).subscriberToken, state.tokens.get("crow-0867ac2809-app")[0]);
});

test("co-hosted instances sharing one ntfy get their own users, topic and tokens", async () => {
  const a = tmpData();
  const b = tmpData();
  const { state, runner } = fakeNtfy();
  await provisionNtfy({ runner, env: a.env, instanceId: ID_A, sleep: noSleep });
  await provisionNtfy({ runner, env: b.env, instanceId: ID_B, sleep: noSleep });
  const ca = readStoredNtfyConfig(a.env);
  const cb = readStoredNtfyConfig(b.env);
  assert.notEqual(ca.topic, cb.topic);
  assert.equal(cb.topic, "crow-c22c6af81c");
  assert.notEqual(ca.publisherToken, cb.publisherToken);
  assert.equal(state.users.size, 4);
});

test("the instance id comes from the instance's own data dir", async () => {
  const { env, data } = tmpData();
  writeFileSync(join(data, "instance-id"), ID_B);
  const { runner } = fakeNtfy();
  const r = await provisionNtfy({ runner, env, sleep: noSleep });
  assert.equal(r.topic, "crow-c22c6af81c");
});

test("failures are plain-language and write nothing", async () => {
  const { env } = tmpData();
  let r = await provisionNtfy({ runner: fakeNtfy({ running: false }).runner, env, instanceId: ID_A, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not running/);
  r = await provisionNtfy({ runner: fakeNtfy({ authFile: false }).runner, env, instanceId: ID_A, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no user database/);
  assert.equal(existsSync(ntfyConfigPath(env)), false);
});

test("a just-started server (auth db not created yet) is waited for", async () => {
  const { env } = tmpData();
  const { runner } = fakeNtfy({ notStartedFor: 2 });
  let slept = 0;
  const r = await provisionNtfy({ runner, env, instanceId: ID_A, sleep: async () => { slept++; } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(slept, 2);
  // …but not forever.
  const r2 = await provisionNtfy({ runner: fakeNtfy({ notStartedFor: 99 }).runner, env: tmpData().env, instanceId: ID_A, startWaitMs: 0, sleep: noSleep });
  assert.equal(r2.ok, false);
});

// ─── boot ensure ───

test("boot ensure: kill switch, env hosts and configured hosts are left alone", async () => {
  const { env } = tmpData();
  const { state, runner } = fakeNtfy();
  const log = () => {};
  assert.equal((await autowireAtBoot({ env: { ...env, CROW_DISABLE_NTFY_AUTOWIRE: "1" }, runner, log })).skipped, "disabled");
  assert.equal((await autowireAtBoot({ env: { ...env, NTFY_TOPIC: "x" }, runner, log })).skipped, "env");
  assert.equal((await autowireAtBoot({ env, runner: fakeNtfy({ running: false }).runner, log })).skipped, "no-server");
  assert.equal(state.calls.length, 0);
  const r = await autowireAtBoot({ env: { ...env }, runner, log, installedIds: () => ["ntfy"] });
  // instance id comes from the data dir; none there and env !== process.env → plain failure, no throw
  assert.equal(r.ok, false);
  writeFileSync(join(env.CROW_DATA_DIR, "instance-id"), ID_A);
  assert.equal((await autowireAtBoot({ env, runner, log, installedIds: () => ["ntfy"] })).ok, true);
  assert.equal((await autowireAtBoot({ env, runner, log, installedIds: () => ["ntfy"] })).skipped, "configured");
});

test("boot ensure provisions a co-hosted instance when another instance's crow-ntfy is running", async () => {
  const { env, data } = tmpData();
  writeFileSync(join(data, "instance-id"), ID_B);
  const { runner } = fakeNtfy();
  const r = await autowireAtBoot({ env, runner, log: () => {}, installedIds: () => [] });
  assert.equal(r.ok, true);
  assert.equal(readStoredNtfyConfig(env).topic, "crow-c22c6af81c");
});

test("installedBundleIds reads both installed.json shapes", () => {
  const { home, env } = tmpData();
  writeFileSync(join(home, "installed.json"), JSON.stringify([{ id: "ntfy" }, "tasks"]));
  assert.deepEqual(installedBundleIds(env), ["ntfy", "tasks"]);
  writeFileSync(join(home, "installed.json"), JSON.stringify({ ntfy: { version: "1" } }));
  assert.deepEqual(installedBundleIds(env), ["ntfy"]);
  assert.deepEqual(installedBundleIds({ CROW_HOME: join(home, "nope") }), []);
});

// ─── route + sender (process.env-scoped) ───

const NTFY_KEYS = ["NTFY_TOPIC", "NTFY_EXTRA_TOPICS", "NTFY_AUTH_TOKEN", "NTFY_SUBSCRIBER_TOKEN", "NTFY_EXTERNAL_URL", "NTFY_HOST", "NTFY_PORT", "CROW_GATEWAY_URL", "CROW_DATA_DIR", "NTFY_CLICK_BASE_URL"];
async function withEnv(patch, fn) {
  const saved = Object.fromEntries(NTFY_KEYS.map((k) => [k, process.env[k]]));
  for (const k of NTFY_KEYS) delete process.env[k];
  Object.assign(process.env, patch);
  try { return await fn(); } finally {
    for (const k of NTFY_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

async function routeGet(path) {
  const { default: pushRouter, _resetAppFetchThrottleForTest } = await import("../servers/gateway/routes/push.js");
  _resetAppFetchThrottleForTest();
  const app = express();
  app.use(pushRouter((req, res, next) => next()));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { "user-agent": "CrowAndroid/1" } });
    return await res.json();
  } finally {
    server.close();
  }
}

test("/api/push/ntfy-config hands the app the READ-ONLY token in auto mode", async () => {
  const { env } = tmpData();
  writeStoredNtfyConfig({ topic: "crow-0867ac2809", publisherToken: "tk_PUBLISHER", subscriberToken: "tk_reader", port: 2586, externalUrl: "https://crow.example.ts.net:8445" }, env);
  await withEnv({ CROW_DATA_DIR: env.CROW_DATA_DIR }, async () => {
    const j = await routeGet("/api/push/ntfy-config");
    assert.deepEqual(j, { enabled: true, url: "https://crow.example.ts.net:8445", topic: "crow-0867ac2809", topics: ["crow-0867ac2809"], authToken: "tk_reader" });
    assert.ok(!JSON.stringify(j).includes("tk_PUBLISHER"));
    assert.equal(readNtfyStatus(env).appFetchedBy, "android");
    assert.ok(readNtfyStatus(env).appFetchedAt);
  });
});

test("/api/push/ntfy-config: env hosts answer exactly as before; nothing configured → disabled", async () => {
  const { env } = tmpData();
  await withEnv({ CROW_DATA_DIR: env.CROW_DATA_DIR }, async () => {
    assert.deepEqual(await routeGet("/api/push/ntfy-config"), { enabled: false });
  });
  await withEnv({ CROW_DATA_DIR: env.CROW_DATA_DIR, NTFY_TOPIC: "kevin", NTFY_EXTRA_TOPICS: "kevin-mpa", NTFY_AUTH_TOKEN: "tk_e", NTFY_EXTERNAL_URL: "https://ntfy.example" }, async () => {
    assert.deepEqual(await routeGet("/api/push/ntfy-config"), { enabled: true, url: "https://ntfy.example", topic: "kevin", topics: ["kevin", "kevin-mpa"], authToken: "tk_e" });
  });
  await withEnv({ CROW_DATA_DIR: env.CROW_DATA_DIR, NTFY_TOPIC: "kevin" }, async () => {
    assert.deepEqual(await routeGet("/api/push/ntfy-config"), { enabled: false }, "no external URL and no gateway URL");
  });
});

async function fakeNtfyHttp(status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => { seen.push({ url: req.url, auth: req.headers.authorization, title: req.headers["x-title"], body }); res.writeHead(status); res.end("{}"); });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { seen, port: server.address().port, close: () => server.close() };
}

test("the sender publishes with the publisher token to the autowired topic and records success", async () => {
  const { env } = tmpData();
  const srv = await fakeNtfyHttp(200);
  try {
    writeStoredNtfyConfig({ topic: "crow-0867ac2809", publisherToken: "tk_pub", subscriberToken: "tk_app", host: "127.0.0.1", port: srv.port }, env);
    await withEnv({ CROW_DATA_DIR: env.CROW_DATA_DIR }, async () => {
      const { sendNtfyNotification } = await import("../servers/gateway/push/ntfy.js");
      const r = await sendNtfyNotification({ title: "Hi", body: "there" });
      assert.equal(r.ok, true);
    });
    assert.equal(srv.seen[0].url, "/crow-0867ac2809");
    assert.equal(srv.seen[0].auth, "Bearer tk_pub");
    const st = readNtfyStatus(env);
    assert.equal(st.lastPushOk, true);
    assert.equal(st.lastPushStatus, 200);
    assert.equal(st.lastPushSource, "auto");
  } finally { srv.close(); }
});

test("a refused publish (403) is reported, not swallowed; unconfigured → skipped", async () => {
  const { env } = tmpData();
  const srv = await fakeNtfyHttp(403);
  try {
    await withEnv({ CROW_DATA_DIR: env.CROW_DATA_DIR, NTFY_TOPIC: "kevin-r4", NTFY_HOST: "127.0.0.1", NTFY_PORT: String(srv.port) }, async () => {
      const { sendNtfyNotification } = await import("../servers/gateway/push/ntfy.js");
      const r = await sendNtfyNotification({ title: "Hi" });
      assert.equal(r.ok, false);
      assert.equal(r.status, 403);
    });
    const st = readNtfyStatus(env);
    assert.equal(st.lastPushOk, false);
    assert.match(st.lastPushError, /403/);
    assert.equal(srv.seen[0].auth, undefined, "env host without a token sends none (unchanged)");
    const other = tmpData();
    await withEnv({ CROW_DATA_DIR: other.env.CROW_DATA_DIR }, async () => {
      const { sendNtfyNotification } = await import("../servers/gateway/push/ntfy.js");
      assert.deepEqual(await sendNtfyNotification({ title: "x" }), { ok: false, skipped: true });
    });
    assert.deepEqual(readNtfyStatus(other.env), {}, "a skipped send records nothing");
  } finally { srv.close(); }
});

// ─── bundle + suite wiring ───

test("the ntfy bundle declares autowire, runs with a user database, and no longer propagates a topic", () => {
  const m = JSON.parse(readFileSync(new URL("../bundles/ntfy/manifest.json", import.meta.url), "utf8"));
  assert.equal(m.autowire, "ntfy-push");
  assert.equal(m.version, "1.1.0");
  assert.deepEqual(m.env_vars.map((v) => v.name), ["NTFY_PORT"]);
  const compose = readFileSync(new URL("../bundles/ntfy/docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /NTFY_AUTH_FILE: \/var\/lib\/ntfy\/auth\.db/);
  assert.match(compose, /NTFY_AUTH_DEFAULT_ACCESS: deny-all/);
  assert.match(compose, /container_name: crow-ntfy/);
  assert.match(compose, /127\.0\.0\.1:\$\{NTFY_PORT:-2586\}:80/);
});

test("run-suite forces the autowire kill switch for scratch gateways", () => {
  const src = readFileSync(new URL("../scripts/run-suite.mjs", import.meta.url), "utf8");
  assert.match(src, /env\.CROW_DISABLE_NTFY_AUTOWIRE = "1"/);
  assert.equal(process.env.CROW_DISABLE_NTFY_AUTOWIRE ?? "1", "1");
});

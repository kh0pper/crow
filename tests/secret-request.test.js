/**
 * Credential card Task 2 (R1.2 spec §10.2, §10.3 item 4, §10.5): the in-memory request store,
 * the target registry (keychain only), the bot-only signed /secrets/mcp mount with
 * crow_request_secret, the implied grant, and the next-turn notes.
 *
 * Runs on the canary harness (tests/fixtures/credential-canary.mjs): the real Perch engine with a
 * FakePi and the real perch-api router, in a scratch CROW_HOME. The harness is built BEFORE any
 * gateway module is imported, so every import below is dynamic.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createCanaryHarness, makeCanary } from "./fixtures/credential-canary.mjs";

let h, store, targetsMod, mcpMod;
before(async () => {
  h = await createCanaryHarness({ services: false });
  store = await import("../servers/gateway/secrets/request-store.js");
  targetsMod = await import("../servers/gateway/secrets/targets.js");
  mcpMod = await import("../servers/gateway/secrets/mcp.js");
});
after(async () => { if (h) await h.close(); });
beforeEach(() => { store._resetSecretStoreForTest(); });

const req = (o = {}) => ({ sessionId: "perchlive-aaaa1111", threadId: "perchlive-aaaa1111", botId: "bot-a", kind: "password", target: "keychain", label: "Example site", ...o });

// ---------------------------------------------------------------------------
// The request store
// ---------------------------------------------------------------------------

test("create, one open per session", () => {
  const { id } = store.createSecretRequest(req());
  assert.match(id, /^[0-9a-f]{32}$/, "128-bit random hex");
  const r = store.getSecretRequest(id);
  assert.equal(r.expiresAt - r.createdAt, 10 * 60 * 1000, "expires 10 minutes after it is made");
  assert.equal(r.label, "Example site");
  assert.ok(!("value" in r), "a request never holds a value");
  assert.throws(() => store.createSecretRequest(req({ label: "again" })), (e) => e.code === "one_open");
  // Another session is independent.
  const other = store.createSecretRequest(req({ sessionId: "perchlive-bbbb2222", threadId: "perchlive-bbbb2222" }));
  assert.notEqual(other.id, id);
  // Closing frees the session for a new request.
  assert.deepEqual(store.cancelSecret(id, "perchlive-aaaa1111"), { outcome: "ok", note: "You closed the form. Nothing was sent." });
  assert.ok(store.createSecretRequest(req()).id);
});

test("expired", () => {
  let t = 1_000_000;
  store._setClockForTest(() => t);
  const { id } = store.createSecretRequest(req());
  t += 10 * 60 * 1000 - 1;
  assert.ok(store.getSecretRequest(id), "still open just before 10 minutes");
  t += 1;
  assert.deepEqual(store.claimSecret(id, { sessionId: "perchlive-aaaa1111" }), { outcome: "expired" });
  assert.deepEqual(store.claimSecret(id, { sessionId: "perchlive-aaaa1111" }), { outcome: "not_found" }, "gone after expiry");
  assert.deepEqual(store.takeSecretNotes("perchlive-aaaa1111"), ["The password request expired. Nothing was sent."]);
  // A sweep alone expires it too (no claim needed), and the session can ask again.
  const second = store.createSecretRequest(req());
  t += 10 * 60 * 1000;
  assert.deepEqual(store.takeSecretNotes("perchlive-aaaa1111"), ["The password request expired. Nothing was sent."]);
  assert.equal(store.getSecretRequest(second.id), null);
  assert.ok(store.createSecretRequest(req()).id, "an expired request no longer counts as open");
});

test("replay", () => {
  const { id } = store.createSecretRequest(req());
  const first = store.claimSecret(id, { sessionId: "perchlive-aaaa1111" });
  assert.equal(first.outcome, "ok");
  assert.equal(first.request.id, id);
  assert.deepEqual(store.claimSecret(id, { sessionId: "perchlive-aaaa1111" }), { outcome: "not_found" }, "single use");
  assert.deepEqual(store.cancelSecret(id, "perchlive-aaaa1111"), { outcome: "not_found" });
  for (const bad of ["", "nope", id.toUpperCase(), id + "0", null, 42]) {
    assert.deepEqual(store.claimSecret(bad, { sessionId: "perchlive-aaaa1111" }), { outcome: "not_found" });
  }
});

test("cross-session", () => {
  const { id } = store.createSecretRequest(req());
  assert.deepEqual(store.claimSecret(id, { sessionId: "perchlive-bbbb2222" }), { outcome: "wrong_session" });
  assert.deepEqual(store.claimSecret(id, {}), { outcome: "wrong_session" });
  assert.deepEqual(store.cancelSecret(id, "perchlive-bbbb2222"), { outcome: "wrong_session" });
  assert.deepEqual(store.takeSecretNotes("perchlive-bbbb2222"), [], "a wrong cancel tells nobody anything");
  assert.equal(store.claimSecret(id, { sessionId: "perchlive-aaaa1111" }).outcome, "ok", "a wrong claim never burns the owner's request");
});

test("browser target refused", () => {
  for (const target of ["browser", "pty", "", "KEYCHAIN", undefined]) {
    assert.throws(() => store.createSecretRequest(req({ target })), (e) => e.code === "bad_target" && e.message === "That kind of request isn't available yet.", String(target));
  }
  assert.throws(() => store.createSecretRequest(req({ kind: "token" })), (e) => e.code === "bad_target");
  assert.deepEqual(targetsMod.targets.names(), ["keychain"], "only keychain ships");
  assert.equal(store.openRequestFor("perchlive-aaaa1111"), null, "a refused request leaves nothing open");
});

test("keychain deliver stores sealed and notes the name only", async () => {
  const c = makeCanary();
  const keyFile = join(h.crowHome, "secrets", "keychain.key");
  // No keychain key yet: refused with the fixed note, and no key is created.
  {
    const { id } = store.createSecretRequest(req());
    const { request } = store.claimSecret(id, { sessionId: "perchlive-aaaa1111" });
    const out = await store.deliverSecret(request, c, { db: h.db, crowHome: h.crowHome });
    assert.deepEqual(out, { ok: false, note: "The keychain isn't set up yet. Nothing was saved." });
    assert.equal(existsSync(keyFile), false, "never creates a key silently");
    assert.deepEqual(await h.keychainRows(), []);
    assert.deepEqual(store.takeSecretNotes("perchlive-aaaa1111"), ["The keychain isn't set up yet. Nothing was saved."]);
  }
  const { createKeychainKey } = await import("../servers/gateway/keychain/key.js");
  createKeychainKey({ crowHome: h.crowHome });
  const audits = [];
  const audit = async (_db, event, o) => { audits.push({ event, ...o }); };
  // With a label.
  {
    const { id } = store.createSecretRequest(req());
    const { request } = store.claimSecret(id, { sessionId: "perchlive-aaaa1111" });
    const out = await store.deliverSecret(request, c, { db: h.db, crowHome: h.crowHome, audit });
    const rows = await h.keychainRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "manual");
    assert.equal(rows[0].label, "Example site");
    assert.ok(!JSON.stringify(rows[0]).includes(c), "the row holds no plaintext");
    assert.equal(await h.openKeychain(rows[0].id), c, "the sealed row decrypts to the value");
    assert.deepEqual(out, { ok: true, note: `Saved in the keychain as "Example site" (entry ${rows[0].id}).`, entryId: Number(rows[0].id) });
    assert.deepEqual(store.takeSecretNotes("perchlive-aaaa1111"), [out.note]);
    assert.deepEqual(audits, [{ event: "keychain_add", details: { entry_id: Number(rows[0].id), label: "Example site", source: "secret_request", bot_id: "bot-a" } }]);
  }
  // Without a label: "<bot>: password".
  {
    const { id } = store.createSecretRequest(req({ label: "  \n " }));
    const { request } = store.claimSecret(id, { sessionId: "perchlive-aaaa1111" });
    const out = await store.deliverSecret(request, c, { db: h.db, crowHome: h.crowHome });
    const rows = await h.keychainRows();
    assert.equal(rows[1].label, "bot-a: password");
    assert.equal(out.note, `Saved in the keychain as "bot-a: password" (entry ${rows[1].id}).`);
  }
  // A throwing target: the fixed note, a fixed log line, never the value or the error text.
  {
    targetsMod.registerTarget("boom", { validate: () => true, deliver: async (_r, v) => { throw new Error("bad " + v); } });
    const { id } = store.createSecretRequest(req({ target: "boom" }));
    const { request } = store.claimSecret(id, { sessionId: "perchlive-aaaa1111" });
    const out = await store.deliverSecret(request, c, {});
    assert.deepEqual(out, { ok: false, note: "The password couldn't be used. Nothing was sent." });
  }
  // The value appears nowhere but the sealed row (and the masking file the harness allows).
  assert.deepEqual(await h.grepEverywhere(c), []);
});

// ---------------------------------------------------------------------------
// The next-turn notes
// ---------------------------------------------------------------------------

test("notes ride the next message once", async () => {
  const s = await h.spawnSession("note-bot");
  const { id } = store.createSecretRequest(req({ sessionId: s.sessionId, threadId: s.threadId, botId: "note-bot" }));
  store.cancelSecret(id, s.sessionId);
  const p = h.pi();
  const r1 = await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, { message: "hello" });
  assert.equal(r1.status, 202);
  assert.equal(p.lastTurn().message, "[Crow] You closed the form. Nothing was sent.\n\nhello");
  await h.endTurn("ok");
  const r2 = await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, { message: "again" });
  assert.equal(r2.status, 202);
  assert.equal(p.lastTurn().message, "again", "taken once");
  await h.endTurn("ok");
  // A turn that never starts hands the note back for the next message.
  store.addSecretNote(s.sessionId, "The password request expired. Nothing was sent.");
  const busy = await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, { message: "one" });
  assert.equal(busy.status, 202);
  store.addSecretNote(s.sessionId, "You closed the form. Nothing was sent.");
  const refused = await h.post(`/dashboard/perch-api/interactive/${s.sessionId}/message`, { message: "two" });
  assert.equal(refused.status, 409, "a turn is in flight");
  assert.deepEqual(store.takeSecretNotes(s.sessionId), ["You closed the form. Nothing was sent."], "handed back");
  await h.endTurn("ok");
});

// ---------------------------------------------------------------------------
// The /secrets/mcp mount and crow_request_secret
// ---------------------------------------------------------------------------

async function mountSecrets({ emitSecretCard } = {}) {
  const { default: express } = await import("express");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { SessionManager } = await import("../servers/gateway/session-manager.js");
  const { mountMcpServer } = await import("../servers/gateway/routes/mcp.js");
  const { localTokenAuthMiddleware, SECRETS_TOKEN, generateLocalToken, generatePhoneToken } = await import("../servers/gateway/local-token.js");
  const { initGatewayActorKey, verifySecretsActorSig } = await import("../scripts/pi-bots/actor-sig.mjs");
  initGatewayActorKey();
  await SECRETS_TOKEN.rotate(h.db);
  const fullToken = await generateLocalToken(h.db);
  const phoneToken = await generatePhoneToken(h.db);
  const app = express();
  app.use(express.json());
  app.use(localTokenAuthMiddleware(h.db));
  const noAuth = (req, res) => res.status(401).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32001, message: "unauthorized" } });
  const sm = new SessionManager();
  const isLiveSession = (sid, o) => h.engine.isLiveSession(sid, o);
  mountMcpServer(app, "/secrets", () => mcpMod.createSecretsMcpServer({ verifyActor: verifySecretsActorSig, isLiveSession, emitSecretCard }), sm, noAuth);
  mountMcpServer(app, "/memory", () => new McpServer({ name: "stub", version: "0" }), sm, noAuth);
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { server, port: server.address().port, fullToken, phoneToken, secretsToken: SECRETS_TOKEN };
}

async function client(m, path, headers = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${m.port}${path}`), { requestInit: { headers } });
  const c = new Client({ name: "secrets-test", version: "0" });
  await c.connect(t);
  // End the server-side session too (DELETE), so the gateway's session logger stops its
  // flush timer and the test process can exit.
  const close = c.close.bind(c);
  c.close = async () => { try { await t.terminateSession(); } catch { /* already gone */ } await close(); };
  openClients.add(c);
  return c;
}
const openClients = new Set();
/** Close every client (also after a failed assertion) and the mount. */
async function teardown(m) {
  for (const c of openClients) { try { await c.close(); } catch { /* closed */ } }
  openClients.clear();
  await new Promise((r) => m.server.close(r));
}

const callText = async (c, args) => {
  const r = await c.callTool({ name: "crow_request_secret", arguments: args });
  return { text: r.content[0].text, isError: !!r.isError };
};

test("tool refuses unsigned, non-perch and dead-session actors", async () => {
  const { crowServerCatalog } = await import("../scripts/pi-bots/crow-server-catalog.mjs");
  const { signSecretsActor, signArtifactsActor } = await import("../scripts/pi-bots/actor-sig.mjs");
  const emitted = [];
  const m = await mountSecrets({ emitSecretCard: (sid, frame, o) => { emitted.push({ sid, frame, o }); return { delivered: true }; } });
  try {
    const live = await h.spawnSession("tool-bot");
    const block = (o) => crowServerCatalog(h.crowHome, { botId: "tool-bot", gatewayType: "perch", gatewayPort: m.port, ...o }).servers["crow-secrets"];
    const good = block({ threadId: live.sessionId });
    assert.equal(good.url, `http://127.0.0.1:${m.port}/secrets/mcp`);
    assert.equal(good.headers["X-Crow-Actor-Sig"], signSecretsActor({ botId: "tool-bot", threadId: live.sessionId, gatewayType: "perch" }), "signed like artifactsBlock, kind secrets");

    const REFUSED = "Password requests work only in a live Perch chat with the operator.";
    const args = { kind: "password", target: "keychain", label: "Example site" };
    const auth = { Authorization: good.headers.Authorization };
    const H = good.headers;
    const strip = (o, k) => { const x = { ...o }; delete x[k]; return x; };
    const refusals = {
      "unsigned": strip(H, "X-Crow-Actor-Sig"),
      "bad signature": { ...H, "X-Crow-Actor-Sig": "0".repeat(64) },
      "another kind's signature": { ...H, "X-Crow-Actor-Sig": signArtifactsActor({ botId: "tool-bot", threadId: live.sessionId, gatewayType: "perch" }) },
      "forged thread": { ...H, "X-Crow-Actor-Thread": "perchlive-other111" },
      "no actor headers (bare token)": auth,
      "operator's full token, no actor": { Authorization: "Bearer " + m.fullToken },
      "non-perch (discord) actor": block({ threadId: "discord:42", gatewayType: "discord" }).headers,
      "non-perch actor naming a live Perch session": block({ threadId: live.sessionId, gatewayType: "discord" }).headers,
      "no gateway": block({ threadId: live.sessionId, gatewayType: null }).headers,
      "another bot naming this session": crowServerCatalog(h.crowHome, { botId: "other-bot", threadId: live.sessionId, gatewayType: "perch", gatewayPort: m.port }).servers["crow-secrets"].headers,
      "unknown session": block({ threadId: "perchlive-dead0000" }).headers,
    };
    for (const [why, headers] of Object.entries(refusals)) {
      const c = await client(m, "/secrets/mcp", headers);
      assert.deepEqual(await callText(c, args), { text: REFUSED, isError: true }, why);
      await c.close();
    }
    // Tokens are path-scoped: the secrets token opens nothing else, and no other token opens /secrets.
    await assert.rejects(client(m, "/memory/mcp", H));
    await assert.rejects(client(m, "/secrets/mcp", { ...H, Authorization: "Bearer " + m.phoneToken }));
    assert.deepEqual(emitted, [], "no card for any refused caller");
    assert.equal(store.openRequestFor(live.sessionId), null);

    // The live Perch actor: returns at once, the card frame goes out, one request is open.
    const c = await client(m, "/secrets/mcp", H);
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["crow_request_secret"]);
    assert.deepEqual(await callText(c, args), { text: "A password card is showing to the operator. You'll get a note on your next turn saying what happened.", isError: false });
    const open = store.openRequestFor(live.sessionId);
    assert.ok(open);
    assert.equal(open.botId, "tool-bot");
    assert.equal(open.label, "Example site");
    assert.deepEqual(emitted, [{ sid: live.sessionId, frame: { type: "secret_request", id: open.id }, o: { botId: "tool-bot" } }]);
    assert.deepEqual(await callText(c, args), { text: "A password card is already open in this chat. Wait for its note on your next turn.", isError: true });
    store.cancelSecret(open.id, live.sessionId);
    assert.deepEqual(await callText(c, { ...args, target: "browser" }), { text: "That kind of request isn't available yet.", isError: true });
    await c.close();

    // A dead (stopped) session is refused even with a perfect signature.
    await h.engine.stop(live.sessionId);
    const c2 = await client(m, "/secrets/mcp", H);
    assert.deepEqual(await callText(c2, args), { text: REFUSED, isError: true }, "stopped session");
    await c2.close();
  } finally {
    await teardown(m);
  }
});

test("the card seam: a no-op by default; an undelivered card drops the request", async () => {
  const m = await mountSecrets({ emitSecretCard: () => ({ delivered: false, reason: "no_session" }) });
  try {
    const { crowServerCatalog } = await import("../scripts/pi-bots/crow-server-catalog.mjs");
    const live = await h.spawnSession("seam-bot");
    const H = crowServerCatalog(h.crowHome, { botId: "seam-bot", threadId: live.sessionId, gatewayType: "perch", gatewayPort: m.port }).servers["crow-secrets"].headers;
    const c = await client(m, "/secrets/mcp", H);
    assert.deepEqual(await callText(c, { kind: "password", target: "keychain" }), { text: "The password card couldn't be shown. Nothing was sent.", isError: true });
    assert.equal(store.openRequestFor(live.sessionId), null);
    await c.close();
  } finally {
    await teardown(m);
  }
  // The module default: no hook installed → undefined (no-op); an installed hook is used.
  assert.equal(mcpMod.emitSecretCard("s", { type: "secret_request" }, { botId: "b" }), undefined);
  const seen = [];
  mcpMod.setEmitSecretCard((...a) => { seen.push(a); return { delivered: true }; });
  try {
    assert.deepEqual(mcpMod.emitSecretCard("s", { type: "secret_request", id: "x" }, { botId: "b" }), { delivered: true });
    assert.deepEqual(seen, [["s", { type: "secret_request", id: "x" }, { botId: "b" }]]);
  } finally { mcpMod.setEmitSecretCard(null); }
});

// ---------------------------------------------------------------------------
// The grant
// ---------------------------------------------------------------------------

test("ensureServers grants with browser or workspace", async () => {
  const { buildBotMcp, impliedServers } = await import("../scripts/pi-bots/mcp_writer.mjs");
  const { buildToolsCsv } = await import("../scripts/pi-bots/bridge.mjs");
  const canonical = { mcpServers: { "crow-browser": { command: "node", args: ["b"] }, tasks: { command: "node", args: ["t"] } } };
  const secrets = { url: "http://127.0.0.1:3001/secrets/mcp", headers: { Authorization: "Bearer t" } };
  const catalog = { tasks: { command: "node", args: ["t"], env: {} }, "crow-secrets": secrets };
  const def = (crow_mcp) => ({ tools: { crow_mcp } });
  const TOOL = "mcp__crow-secrets__crow_request_secret";
  const resolved = { provider: "crow-local", model: "m" };

  for (const sel of [["crow-browser/browser_navigate"], ["browser/browser_navigate"], ["workspace/docs_create"], ["google-workspace/gmail_create_draft"], ["workspace"]]) {
    assert.deepEqual(impliedServers(def(sel)), ["crow-secrets"], sel[0]);
    const r = buildBotMcp(def(sel), canonical, { catalog, unconfigured: {} });
    assert.deepEqual(r.json.mcpServers["crow-secrets"], secrets, sel[0]);
    assert.ok(r.servers.includes("crow-secrets"));
    assert.ok(buildToolsCsv(def(sel), { resolved, interactive: true }).csv.split(",").includes(TOOL), "Perch csv carries the tool: " + sel[0]);
    assert.ok(!buildToolsCsv(def(sel), { resolved, interactive: false }).csv.includes(TOOL), "a channel csv stays unchanged: " + sel[0]);
  }
  // No browser or Workspace: nothing implied, nothing minted.
  const plain = def(["tasks/tasks_list"]);
  assert.deepEqual(impliedServers(plain), []);
  assert.equal(buildBotMcp(plain, canonical, { catalog, unconfigured: {} }).json.mcpServers["crow-secrets"], undefined);
  assert.ok(!buildToolsCsv(plain, { resolved, interactive: true }).csv.includes(TOOL));
  // Implied but absent from the catalog (no token): skipped silently, no warning.
  const noTok = buildBotMcp(def(["crow-browser/browser_navigate"]), canonical, { catalog: { tasks: catalog.tasks }, unconfigured: {} });
  assert.equal(noTok.json.mcpServers["crow-secrets"], undefined);
  assert.ok(!noTok.warnings.some((w) => /crow-secrets/.test(w)), JSON.stringify(noTok.warnings));
  // Explicitly selectable on its own.
  const explicit = def(["crow-secrets/crow_request_secret"]);
  assert.deepEqual(buildBotMcp(explicit, canonical, { catalog, unconfigured: {} }).json.mcpServers["crow-secrets"], secrets);
  assert.equal(buildToolsCsv(explicit, { resolved, interactive: true }).csv.split(",").filter((t) => t === TOOL).length, 1, "no duplicate");
  // Narrowing can still take it away.
  const narrowed = buildToolsCsv(def(["crow-browser/browser_navigate"]), { resolved, interactive: true, narrowedTools: JSON.stringify([TOOL]) }).csv;
  assert.ok(!narrowed.includes(TOOL), narrowed);
});

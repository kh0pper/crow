/**
 * Bot bash policy vocabulary + the safety-classifier resolver
 * (servers/shared/bot-bash-policy.js), rev c.
 *
 * Stored values: deny | ask | auto | allowlist. A stored "sandbox" (never
 * implemented, always blocked) reads as DENY until the owner confirms the
 * switch to auto once in Bot Builder; other unknown values read as deny.
 *
 * Classifier trust boundary: auto-detect takes only a row THIS instance wrote
 * that THIS machine serves; an operator may name another endpoint explicitly
 * in the per-instance (never synced) setting, but only on loopback or the
 * tailnet (100.64.0.0/10, Tailscale IPv6, or a *.ts.net name that resolves
 * there) — never a public host, never a row synced from a peer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASH_POLICIES,
  isValidBashPolicy,
  normalizeStoredBashPolicy,
  isTrustedClassifierUrl,
  parseClassifierSetting,
  selectBotClassifier,
  resolveClassifierEndpoint,
  classifierPolicyBlock,
} from "../servers/shared/bot-bash-policy.js";

const OWN_ID = "a".repeat(32);
const PEER_ID = "b".repeat(32);
const OWN = new Set(["127.0.0.1", "100.64.20.5", "10.20.30.5"]);
const row = (o) => ({ disabled: 0, host: "local", provider_type: null, gpu_policy: null, models: "[]", instance_id: OWN_ID, ...o });
const voice = row({ id: "crow-voice", base_url: "http://100.64.20.5:8011/v1",
  models: JSON.stringify([{ id: "qwen3.5-4b" }]), gpu_policy: JSON.stringify({ alwaysResident: true }) });
const native = row({ id: "qwen3.5-4b", base_url: "http://127.0.0.1:18100/v1", provider_type: "openai-compat",
  models: JSON.stringify([{ id: "qwen3.5-4b" }]), gpu_policy: JSON.stringify({ runtime: "native" }) });
const cloud = row({ id: "qwen-cloud", base_url: "https://api.example.com/v1", host: "cloud", provider_type: "openai-compat",
  models: JSON.stringify([{ id: "qwen3.5-4b" }, { id: "big" }]) });
const ravenTail = row({ id: "raven", base_url: "http://100.64.20.9:8030/v1", host: "cloud",
  models: JSON.stringify([{ id: "qwen3.5-4b" }]) });
const ravenLan = row({ id: "raven-lan", base_url: "http://10.20.30.9:8030/v1", host: "cloud",
  models: JSON.stringify([{ id: "qwen3.5-4b" }]) });
const sel = (o) => selectBotClassifier({ ownAddresses: OWN, ownInstanceId: OWN_ID, ...o });

test("vocabulary: four stored values, sandbox is not one of them", () => {
  assert.deepEqual([...BASH_POLICIES], ["deny", "ask", "auto", "allowlist"]);
  for (const v of BASH_POLICIES) assert.equal(isValidBashPolicy(v), true);
  for (const v of ["sandbox", "", null, undefined, "AUTO", "open"]) assert.equal(isValidBashPolicy(v), false);
});

test("stored sandbox reads as DENY with an offer to switch to auto; unknown/absent read as deny", () => {
  assert.deepEqual(normalizeStoredBashPolicy("sandbox"), { value: "deny", migratedFrom: "sandbox", offerAuto: true });
  assert.deepEqual(normalizeStoredBashPolicy("weird"), { value: "deny", migratedFrom: "weird", offerAuto: false });
  assert.deepEqual(normalizeStoredBashPolicy(undefined), { value: "deny", migratedFrom: null, offerAuto: false });
  assert.deepEqual(normalizeStoredBashPolicy("auto"), { value: "auto", migratedFrom: null, offerAuto: false });
  for (const v of ["Sandbox", " sandbox", ["sandbox"]]) {
    const n = normalizeStoredBashPolicy(v);
    assert.equal(n.value, "deny");
    assert.equal(n.offerAuto, false);
  }
});

test("normalisation never widens: whitespace, case, arrays, objects all read as deny", () => {
  for (const v of [" auto", "auto ", "AUTO", "Ask", ["auto"], { value: "auto" }, 1, true]) {
    assert.equal(normalizeStoredBashPolicy(v).value, "deny", JSON.stringify(v));
    assert.equal(isValidBashPolicy(v), false, JSON.stringify(v));
  }
});

test("trusted classifier URLs: loopback, tailnet IPs, *.ts.net names; nothing else", () => {
  for (const u of ["http://127.0.0.1:18100/v1", "http://localhost:8011/v1", "http://[::1]:8/v1",
    "http://100.64.20.5:8011/v1", "http://[fd7a:115c:a1e0::5]:8/v1", "https://crow.example.ts.net/v1",
    "http://crow.example.ts.net:8011/v1"]) assert.equal(isTrustedClassifierUrl(u), true, u);
  for (const u of ["https://api.example.com/v1", "http://8.8.8.8/v1", "http://100.128.0.1/v1", "http://10.20.30.9/v1",
    "http://192.168.1.4/v1", "http://172.20.1.1/v1", "not a url", "file:///x", "http://u:p@127.0.0.1/v1",
    "http://ts.net.example.com/v1", "ftp://100.64.20.5/v1"]) assert.equal(isTrustedClassifierUrl(u), false, u);
});

test("setting parse: provider/model or an explicit {url, model} endpoint; junk -> null", () => {
  assert.deepEqual(parseClassifierSetting("crow-voice/qwen3.5-4b"), { provider: "crow-voice", model: "qwen3.5-4b" });
  assert.deepEqual(parseClassifierSetting('"crow-voice/qwen3.5-4b"'), { provider: "crow-voice", model: "qwen3.5-4b" });
  assert.deepEqual(parseClassifierSetting('{"url":"http://100.64.20.9:8030/v1","model":"qwen3.5-4b"}'),
    { url: "http://100.64.20.9:8030/v1", model: "qwen3.5-4b" });
  for (const bad of ["", null, "nomodel", '{"url":1}', '{"model":"m"}']) assert.equal(parseClassifierSetting(bad), null, String(bad));
});

test("auto-detect prefers an always-resident candidate this instance wrote and this machine serves", () => {
  const a = sel({ setting: null, providers: [native, voice, cloud] });
  assert.equal(a.ok, true);
  assert.equal(a.providerId, "crow-voice");
  assert.equal(a.source, "auto");
  assert.equal(a.here, true);
  const b = sel({ setting: null, providers: [native, cloud] });
  assert.equal(b.providerId, "qwen3.5-4b");
});

test("auto-detect ignores peer-synced rows: foreign host OR written by another instance", () => {
  const foreignHost = { ...voice, id: "a1", host: PEER_ID };
  const peerWritten = { ...voice, id: "a2", instance_id: PEER_ID }; // e.g. crow-voice written by grackle
  const r = sel({ setting: null, providers: [foreignHost, peerWritten] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "none");
});

test("auto-detect ignores rows this machine does not serve, cloud rows, LAN rows and disabled rows", () => {
  const elsewhere = { ...voice, id: "a3", base_url: "http://100.64.20.9:8011/v1" };
  const lanSelf = { ...voice, id: "a4", base_url: "http://10.20.30.5:8011/v1" }; // own LAN IP: not loopback/tailnet
  const r = sel({ setting: null, providers: [elsewhere, lanSelf, cloud, ravenTail, { ...native, disabled: 1 }] });
  assert.equal(r.ok, false);
  assert.equal(r.installModel, "qwen3.5-4b");
});

test("explicit provider setting: own-written row on loopback/tailnet only", () => {
  assert.equal(sel({ setting: "raven/qwen3.5-4b", providers: [ravenTail] }).ok, true);
  assert.equal(sel({ setting: "raven/qwen3.5-4b", providers: [ravenTail] }).here, false);
  assert.equal(sel({ setting: "raven-lan/qwen3.5-4b", providers: [ravenLan] }).reason, "setting-not-tailnet");
  assert.equal(sel({ setting: "qwen-cloud/qwen3.5-4b", providers: [cloud] }).reason, "setting-not-tailnet");
  assert.equal(sel({ setting: "raven/qwen3.5-4b", providers: [{ ...ravenTail, instance_id: PEER_ID }] }).reason, "setting-row-not-own");
  assert.equal(sel({ setting: "raven/qwen3.5-4b", providers: [{ ...ravenTail, host: PEER_ID }] }).reason, "setting-row-not-own");
  assert.equal(sel({ setting: "gone/x", providers: [voice] }).reason, "setting-provider-missing");
  assert.equal(sel({ setting: "crow-voice/other", providers: [voice] }).reason, "setting-model-missing");
  assert.equal(sel({ setting: "crow-voice/qwen3.5-4b", providers: [{ ...voice, disabled: 1 }] }).reason, "setting-provider-disabled");
});

test("explicit endpoint setting: the operator names a tailnet box directly (no provider row involved)", () => {
  const ok = sel({ setting: '{"url":"http://100.64.20.9:8030/v1","model":"qwen3.5-4b"}', providers: [] });
  assert.equal(ok.ok, true);
  assert.equal(ok.source, "setting-endpoint");
  assert.equal(ok.where, "100.64.20.9");
  for (const url of ["http://8.8.8.8/v1", "https://api.example.com/v1", "http://10.20.30.9:8030/v1"]) {
    assert.equal(sel({ setting: JSON.stringify({ url, model: "m" }), providers: [] }).reason, "setting-not-tailnet", url);
  }
});

test("a bad setting does NOT silently fall back to auto-detect", () => {
  assert.equal(sel({ setting: "qwen-cloud/qwen3.5-4b", providers: [cloud, native] }).ok, false);
});

test("*.ts.net names are resolved; every address must be on the tailnet; http only for names", async () => {
  const base = sel({ setting: '{"url":"http://box.example.ts.net:8030/v1","model":"m"}', providers: [] });
  assert.equal(base.ok, true);
  const good = await resolveClassifierEndpoint(base, { lookup: async () => [{ address: "100.64.20.9", family: 4 }] });
  assert.equal(good.ok, true);
  assert.equal(good.url, "http://100.64.20.9:8030/v1");
  assert.equal(good.where, "box.example.ts.net (100.64.20.9)");
  const off = await resolveClassifierEndpoint(base, { lookup: async () => [{ address: "100.64.20.9", family: 4 }, { address: "203.0.113.7", family: 4 }] });
  assert.equal(off.ok, false);
  assert.equal(off.reason, "name-resolves-off-tailnet");
  const fail = await resolveClassifierEndpoint(base, { lookup: async () => { throw new Error("ENOTFOUND"); } });
  assert.equal(fail.ok, false);
  const https = sel({ setting: '{"url":"https://box.example.ts.net/v1","model":"m"}', providers: [] });
  assert.equal((await resolveClassifierEndpoint(https, { lookup: async () => [{ address: "100.64.20.9", family: 4 }] })).reason, "https-name-unsupported");
  const ip = sel({ setting: '{"url":"http://100.64.20.9:8030/v1","model":"m"}', providers: [] });
  let looked = false;
  assert.equal((await resolveClassifierEndpoint(ip, { lookup: async () => { looked = true; return []; } })).url, "http://100.64.20.9:8030/v1");
  assert.equal(looked, false);
});

test("policy block carries url + model only — never a key", () => {
  const s = sel({ setting: null, providers: [{ ...voice, api_key: "sk-secret" }] });
  const block = classifierPolicyBlock(s);
  assert.deepEqual(Object.keys(block).sort(), ["model", "timeout_ms", "url"]);
  assert.ok(!JSON.stringify(block).includes("sk-secret"));
  assert.equal(classifierPolicyBlock({ ok: false, reason: "none" }), null);
});

test("the classifier setting is instance-local: never in the sync allowlist", async () => {
  const { isSyncable } = await import("../servers/gateway/dashboard/settings/sync-allowlist.js");
  assert.equal(isSyncable("bot_safety_classifier"), false);
});

test("shape guard: a row without an instance_id column is never trusted", () => {
  const { instance_id, ...noCol } = native;
  assert.equal(selectBotClassifier({ setting: null, providers: [noCol], ownAddresses: OWN, ownInstanceId: OWN_ID }).ok, false);
  assert.equal(selectBotClassifier({ setting: "qwen3.5-4b/qwen3.5-4b", providers: [noCol], ownAddresses: OWN, ownInstanceId: OWN_ID }).reason, "setting-row-not-own");
});

test("review F3: a NULL origin is trusted only for a loopback row", () => {
  const syncedNoOrigin = { ...voice, id: "v-null", instance_id: null };            // tailnet URL, no origin
  assert.equal(sel({ setting: null, providers: [syncedNoOrigin] }).ok, false);
  assert.equal(sel({ setting: "v-null/qwen3.5-4b", providers: [syncedNoOrigin] }).reason, "setting-row-not-own");
  const localSeed = { ...native, id: "n-null", instance_id: null };                // loopback, no origin
  assert.equal(sel({ setting: null, providers: [localSeed] }).ok, true);
  assert.equal(sel({ setting: null, providers: [{ ...native, id: "n-empty", instance_id: "" }] }).ok, true);
});

// --- field-mismatch hardening (2026-10-08): ONE normalised accessor for the
// Perch-only rule, read by the save guard, the peer guard and the bridge.
test("nonPerchChannels: every gateway shape normalises; anything not plainly Perch counts", async () => {
  const { nonPerchChannels, storedShellMode } = await import("../servers/shared/bot-permission-policy.js");
  assert.deepEqual(nonPerchChannels({}), []);
  assert.deepEqual(nonPerchChannels({ gateways: [] }), []);
  assert.deepEqual(nonPerchChannels({ gateways: [{ type: "perch" }, { type: "none" }] }), []);
  assert.deepEqual(nonPerchChannels({ gateways: [{ type: " Gmail " }] }), ["gmail"]);
  assert.deepEqual(nonPerchChannels({ gateways: [{ type: "PERCH" }] }), [], "case-insensitive Perch is Perch");
  assert.deepEqual(nonPerchChannels({ gateways: { type: "discord" } }), ["discord"], "a single object, not an array");
  assert.deepEqual(nonPerchChannels({ gateways: "telegram" }), ["telegram"], "a bare string");
  assert.deepEqual(nonPerchChannels({ gateways: [{}] }), ["unknown"], "an entry without a type is not Perch");
  assert.deepEqual(nonPerchChannels({ gateways: [null, { type: "slack" }] }), ["unknown", "slack"]);
  assert.deepEqual(nonPerchChannels({ gateways: [{ type: 7 }] }), ["unknown"]);
  assert.deepEqual(nonPerchChannels({ gateways: 5 }), ["unknown"]);
  assert.equal(storedShellMode({ bash: "auto" }), "auto");
  assert.equal(storedShellMode({ bash: "sandbox" }), "deny");
  assert.equal(storedShellMode({ bash: " auto" }), "deny");
  assert.equal(storedShellMode(null), "deny");
});

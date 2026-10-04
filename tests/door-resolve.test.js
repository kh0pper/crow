// tests/door-resolve.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDoorTarget, listDoorModels, doorKindOf, isDoorUrl, isForbiddenTarget, canonicalTargetHost, DOOR_PROVIDER_HEADER, DOOR_HOP_HEADER } from "../servers/gateway/models/door-resolve.js";
import { providerDoorUrl } from "../servers/gateway/models/door.js";

const P = {
  "crow-chat": { baseUrl: "http://127.0.0.1:18102/v1", doorUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }], gpuPolicy: { runtime: "native", owner: "me", port: 18102, mutexGroup: "crow-strix-vram", defaultMember: true } },
  "crow-voice": { baseUrl: "http://100.64.9.1:8011/v1", apiKey: "none", bundleId: "vllm-rocm-qwen35-4b", models: [{ id: "qwen3.5-4b" }] },
  "crow-local-27b": { baseUrl: "http://100.64.9.1:8006/v1", apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow", label: "gufo" } } },
  "crow-local-27b-copilot": { baseUrl: "http://100.64.9.1:8010/v1", apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow", label: "gufo" } } },
  "r4-gemma": { baseUrl: "http://100.64.9.1:3008/llm/p/r4-gemma/v1", apiKey: "none", models: [{ id: "gemma-4-e2b-it" }], gpuPolicy: { runtime: "native", owner: "r4", port: 18120 } },
  "qwen-cloud": { baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", apiKey: "sk-secret", models: [{ id: "qwen3.8-max" }] },
  "raven-flash-next": { baseUrl: "http://10.0.0.126:8030/v1", apiKey: "none", models: [{ id: "qwen3.8-flash-next" }], gpuPolicy: { engine: { managed: "external", host: "raven", label: "gufo" } } },
  "lan-box": { baseUrl: "http://10.0.0.50:8000/v1", apiKey: "k-lan", models: [{ id: "lan-model" }] },
  "lan-optin": { baseUrl: "http://10.0.0.51:8000/v1", apiKey: "none", models: [{ id: "optin-model" }], gpuPolicy: { door_forward: true } },
  "evil-bundle": { baseUrl: "http://169.254.169.254/latest", apiKey: "none", bundleId: "x", models: [{ id: "meta" }] },
};
const COMPANION = ["qwen3.5-4b", "qwen3.6-35b-a3b"];

test("isDoorUrl and providerDoorUrl", () => {
  assert.equal(isDoorUrl("http://100.64.9.1:3001/llm/v1"), true);
  assert.equal(isDoorUrl("http://100.64.9.1:3001/llm/p/crow-chat/v1"), true);
  assert.equal(isDoorUrl("http://100.64.9.1:8003/v1"), false);
  assert.equal(providerDoorUrl("http://100.64.9.1:3001/llm/v1", "crow-chat"), "http://100.64.9.1:3001/llm/p/crow-chat/v1");
});

test("isForbiddenTarget: link-local, metadata hosts, Tailscale's own address, garbage", () => {
  for (const u of ["http://169.254.169.254/latest", "http://169.254.1.2:80/v1", "http://[fe80::1]:8000/v1", "http://[fd00:ec2::254]/", "http://100.100.100.200/", "http://100.100.100.100/", "http://metadata.google.internal/", "http://metadata/", "not a url"]) {
    assert.equal(isForbiddenTarget(u), true, u);
  }
  for (const u of ["http://127.0.0.1:18102/v1", "http://100.64.9.1:8006/v1", "http://10.0.0.126:8030/v1"]) assert.equal(isForbiddenTarget(u), false, u);
});

test("isForbiddenTarget: IPv4-mapped IPv6 and trailing-dot bypasses are closed (re-review N1)", () => {
  for (const u of [
    "http://[::ffff:169.254.169.254]/latest", "http://[::ffff:a9fe:a9fe]/latest", "http://[::ffff:100.100.100.100]/",
    "http://[::ffff:6464:64c8]/", "http://[::a9fe:a9fe]/", "http://metadata.google.internal./", "http://metadata./",
    "http://instance-data.ec2.internal./", "http://169.254.169.254./",
  ]) assert.equal(isForbiddenTarget(u), true, u);
  assert.equal(canonicalTargetHost("[::ffff:a9fe:a9fe]"), "169.254.169.254");
  assert.equal(canonicalTargetHost("Metadata.Google.Internal."), "metadata.google.internal");
  assert.equal(isForbiddenTarget("http://[::ffff:7f00:1]:18102/v1"), false, "a mapped loopback is not forbidden (it maps to 127.0.0.1)");
});

test("header names are lower-case (express lower-cases incoming headers)", () => {
  assert.equal(DOOR_PROVIDER_HEADER, "x-crow-provider");
  assert.equal(DOOR_HOP_HEADER, "x-crow-door-hop");
});

test("doorKindOf: managed kinds, the explicit opt-in, and everything else unmanaged", () => {
  assert.equal(doorKindOf(P["crow-chat"]), "native-owned");
  assert.equal(doorKindOf(P["r4-gemma"]), "native-foreign");
  assert.equal(doorKindOf(P["crow-local-27b"]), "external");
  assert.equal(doorKindOf(P["crow-voice"]), "bundle");
  assert.equal(doorKindOf(P["lan-optin"]), "opt-in");
  assert.equal(doorKindOf(P["qwen-cloud"]), "unmanaged");
  assert.equal(doorKindOf(P["lan-box"]), "unmanaged", "a private address is NOT enough");
});

test("the header addresses a provider; the model field stays bare", () => {
  const r = resolveDoorTarget({ providers: P, providerHeader: "crow-local-27b-copilot", model: "qwen3.8-27b", companionModelIds: COMPANION });
  assert.equal(r.kind, "forward");
  assert.equal(r.providerId, "crow-local-27b-copilot");
  assert.equal(r.url, "http://100.64.9.1:8010/v1");
});

test("a qualified model addresses a provider", () => {
  const r = resolveDoorTarget({ providers: P, model: "crow-local-27b/qwen3.8-27b", companionModelIds: COMPANION });
  assert.equal(r.providerId, "crow-local-27b");
  assert.equal(r.modelId, "qwen3.8-27b");
});

test("an owned native row forwards to loopback, never to its own door", () => {
  const r = resolveDoorTarget({ providers: P, providerHeader: "crow-chat", model: "qwen3.6-35b-a3b", companionModelIds: COMPANION });
  assert.equal(r.url, "http://127.0.0.1:18102/v1");
  assert.equal(r.doorKind, "native-owned");
});

test("a foreign-owned native row forwards to the owner's door; a second hop answers 508", () => {
  const r = resolveDoorTarget({ providers: P, model: "r4-gemma/gemma-4-e2b-it", companionModelIds: COMPANION });
  assert.equal(r.url, "http://100.64.9.1:3008/llm/p/r4-gemma/v1");
  const r2 = resolveDoorTarget({ providers: P, model: "r4-gemma/gemma-4-e2b-it", companionModelIds: COMPANION, hop: 1 });
  assert.equal(r2.status, 508);
  assert.equal(r2.code, "DOOR_LOOP");
});

test("unmanaged rows are refused — cloud keys never leak, LAN rows need the opt-in", () => {
  const c = resolveDoorTarget({ providers: P, providerHeader: "qwen-cloud", model: "qwen3.8-max", companionModelIds: COMPANION });
  assert.equal(c.status, 400);
  assert.equal(c.code, "NOT_FORWARDABLE");
  assert.equal(JSON.stringify(c).includes("sk-secret"), false);
  assert.equal(resolveDoorTarget({ providers: P, providerHeader: "lan-box", model: "lan-model", companionModelIds: COMPANION }).code, "NOT_FORWARDABLE");
  assert.equal(resolveDoorTarget({ providers: P, providerHeader: "lan-optin", model: "optin-model", companionModelIds: COMPANION }).kind, "forward");
});

test("a managed row pointing at a metadata address is refused", () => {
  const r = resolveDoorTarget({ providers: P, providerHeader: "evil-bundle", model: "meta", companionModelIds: COMPANION });
  assert.equal(r.status, 400);
  assert.equal(r.code, "FORBIDDEN_TARGET");
});

test("a unique bare id that is not a companion alias resolves; unmanaged rows are not candidates", () => {
  assert.equal(resolveDoorTarget({ providers: P, model: "qwen3.8-flash-next", companionModelIds: COMPANION }).providerId, "raven-flash-next");
  assert.equal(resolveDoorTarget({ providers: P, model: "lan-model", companionModelIds: COMPANION }).kind, "companion", "an unmanaged row is invisible to bare addressing");
});

test("companion alias ids and unknown ids stay with the companion heuristics", () => {
  for (const m of ["qwen3.5-4b", "qwen3.6-35b-a3b", "crow", undefined]) {
    assert.equal(resolveDoorTarget({ providers: P, model: m, companionModelIds: COMPANION }).kind, "companion", String(m));
  }
});

test("an ambiguous bare id answers 400 with the qualified forms, or resolves to a lone defaultMember", () => {
  const r = resolveDoorTarget({ providers: P, model: "qwen3.8-27b", companionModelIds: COMPANION });
  assert.equal(r.code, "AMBIGUOUS_MODEL");
  assert.deepEqual(r.candidates.sort(), ["crow-local-27b-copilot/qwen3.8-27b", "crow-local-27b/qwen3.8-27b"]);
  const P2 = { ...P, "crow-chat-alt": { ...P["crow-chat"], gpuPolicy: { ...P["crow-chat"].gpuPolicy, defaultMember: false, port: 18103 }, baseUrl: "http://127.0.0.1:18103/v1" } };
  assert.equal(resolveDoorTarget({ providers: P2, model: "qwen3.6-35b-a3b", companionModelIds: [] }).providerId, "crow-chat");
});

test("an unknown header provider or a model the provider does not serve is 404", () => {
  assert.equal(resolveDoorTarget({ providers: P, providerHeader: "nope", model: "x", companionModelIds: COMPANION }).status, 404);
  const r = resolveDoorTarget({ providers: P, providerHeader: "crow-voice", model: "qwen3.6-35b-a3b", companionModelIds: COMPANION });
  assert.equal(r.code, "MODEL_NOT_SERVED");
});

test("listDoorModels lists forwardable models only, qualified", () => {
  const ids = listDoorModels(P).map((m) => m.id);
  assert.ok(ids.includes("crow-chat/qwen3.6-35b-a3b"));
  assert.ok(ids.includes("lan-optin/optin-model"));
  assert.equal(ids.some((id) => id.startsWith("qwen-cloud/") || id.startsWith("lan-box/") || id.startsWith("evil-bundle/")), false);
});

// Final fix wave I1: a reverse proxy on the same box (r4's public sslip.io
// front door: black-swan Caddy -> crow Serve :8449 -> r4 on loopback) delivers
// outside clients as 127.0.0.1. A forwarding header is trusted only if EVERY
// address it names is itself loopback or tailnet.
test("isTrustedDoorRequest: plain loopback and tailnet pass; a forwarded chain must be all-trusted", async () => {
  const { isTrustedDoorRequest } = await import("../servers/gateway/models/door-resolve.js");
  assert.equal(isTrustedDoorRequest("127.0.0.1", {}), true, "plain loopback");
  assert.equal(isTrustedDoorRequest("::ffff:127.0.0.1", {}), true);
  assert.equal(isTrustedDoorRequest("100.64.20.3", {}), true, "plain tailnet");
  assert.equal(isTrustedDoorRequest("10.0.0.50", {}), false, "LAN socket");
  assert.equal(isTrustedDoorRequest("10.0.0.50", { "x-forwarded-for": "127.0.0.1" }), false, "a header never upgrades an untrusted socket");
  // public client behind Caddy + Serve (Serve appends the black-swan hop)
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": "168.171.4.20, 100.64.20.3" }), false);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": "8.8.8.8" }), false);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-real-ip": "8.8.8.8" }), false);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { forwarded: 'for=192.0.2.60;proto=https;by=203.0.113.43' }), false);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { forwarded: 'for="[2001:db8:cafe::17]:4711"' }), false);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": "unknown" }), false, "an unparseable entry is untrusted");
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": "" }), true, "an empty header names nobody");
  // tailnet clients through Serve
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": "100.64.20.4" }), true);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": "100.64.20.4:51234, 127.0.0.1" }), true);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { forwarded: 'for="[fd7a:115c:a1e0::5]:443", for=100.64.0.9' }), true);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": ["100.64.0.1", "8.8.8.8"] }), false, "repeated headers: every value counts");
});

test("isDoorUrl is case-insensitive (Express routing is)", () => {
  assert.equal(isDoorUrl("http://100.64.9.1:3001/LLM/V1"), true);
  assert.equal(isDoorUrl("http://100.64.9.1:3001/Llm/P/x/v1"), true);
});

test("a third hop is refused whatever the target looks like", () => {
  const r = resolveDoorTarget({ providers: P, providerHeader: "crow-voice", model: "qwen3.5-4b", companionModelIds: [], hop: 2 });
  assert.equal(r.status, 508);
  assert.equal(r.code, "DOOR_LOOP");
  assert.equal(resolveDoorTarget({ providers: P, providerHeader: "crow-voice", model: "qwen3.5-4b", companionModelIds: [], hop: 1 }).kind, "forward", "one hop to a non-door target is the normal foreign-native case");
});

test("a forwardable-looking row on a public address is refused (the cloud allowlist cannot be bypassed by door_forward or a bundleId)", () => {
  const P3 = {
    "cloud-optin": { baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKey: "sk-paid", models: [{ id: "glm" }], gpuPolicy: { door_forward: true } },
    "cloud-bundle": { baseUrl: "https://maas.example.com/v1", apiKey: "sk-paid", bundleId: "x", models: [{ id: "q" }] },
    "ts-host": { baseUrl: "http://crow.example.ts.net:8011/v1", apiKey: "none", bundleId: "y", models: [{ id: "v" }] },
  };
  for (const id of ["cloud-optin", "cloud-bundle"]) {
    const r = resolveDoorTarget({ providers: P3, providerHeader: id, model: null, companionModelIds: [] });
    assert.equal(r.code, "NOT_FORWARDABLE", id);
    assert.equal(JSON.stringify(r).includes("sk-paid"), false);
  }
  assert.equal(resolveDoorTarget({ providers: P3, providerHeader: "ts-host", model: "v", companionModelIds: [] }).kind, "forward", "a tailnet hostname is local");
  assert.deepEqual(listDoorModels(P3).map((m) => m.id), ["ts-host/v"]);
});

// tests/pi-compat.test.js — the pinned pi facts (roles phase 2 Task 14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PI_PINNED_VERSION, PI_BUILTIN_PROVIDER_IDS, piCompatFor } from "../servers/shared/pi-compat.js";
import { resolvePiCli } from "../scripts/pi-bots/pi_resolver.mjs";

test("the pin is 0.85.1 and the provider id list is frozen", () => {
  assert.equal(PI_PINNED_VERSION, "0.85.1");
  assert.ok(Object.isFrozen(PI_BUILTIN_PROVIDER_IDS));
  assert.ok(PI_BUILTIN_PROVIDER_IDS.includes("openrouter"));
  assert.ok(PI_BUILTIN_PROVIDER_IDS.includes("zai"));
});

test("Z.AI gets the flags pi derives for api.z.ai", () => {
  assert.deepEqual(piCompatFor("https://api.z.ai/api/coding/paas/v4", "glm-5.3"), {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
    thinkingFormat: "zai",
  });
});

test("OpenRouter keys developer role and Anthropic cache control on the model id", () => {
  const claude = piCompatFor("https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5.5");
  assert.equal(claude.cacheControlFormat, "anthropic");
  assert.equal(claude.thinkingFormat, "openrouter");
  assert.equal(claude.sessionAffinityFormat, "openrouter");
  assert.equal("supportsDeveloperRole" in claude, false, "anthropic/ ids keep the developer role (the default)");
  const gpt = piCompatFor("https://openrouter.ai/api/v1", "openai/gpt-5");
  assert.equal("cacheControlFormat" in gpt, false);
  assert.equal("supportsDeveloperRole" in gpt, false);
  const other = piCompatFor("https://openrouter.ai/api/v1", "qwen/qwen3-max");
  assert.equal(other.supportsDeveloperRole, false);
  assert.equal("cacheControlFormat" in other, false);
});

test("other hosts pi checks", () => {
  assert.deepEqual(piCompatFor("https://api.deepseek.com/v1", "deepseek-chat"), {
    supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens",
    requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek",
  });
  assert.deepEqual(piCompatFor("https://api.together.xyz/v1", "m"), {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    maxTokensField: "max_tokens", thinkingFormat: "together", supportsStrictMode: false,
    supportsLongCacheRetention: false,
  });
  assert.deepEqual(piCompatFor("https://api.moonshot.ai/v1", "kimi-k2"), {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    maxTokensField: "max_tokens", supportsStrictMode: false,
  });
  assert.deepEqual(piCompatFor("https://api.x.ai/v1", "grok-4"), {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
  });
  assert.deepEqual(piCompatFor("https://api.cerebras.ai/v1", "m"), { supportsStore: false, supportsDeveloperRole: false });
});

// Table cases for the hosts the tests above don't name. Each expected object
// was checked against the installed pi 0.85.1 detectCompat; the live test at
// the bottom re-checks every row against that function when it is installed.
const D = { supportsStore: false, supportsDeveloperRole: false };
const HOST_TABLE = [
  ["https://api.together.ai/v1", "m", { ...D, supportsReasoningEffort: false, maxTokensField: "max_tokens", thinkingFormat: "together", supportsStrictMode: false, supportsLongCacheRetention: false }],
  ["https://API.DeepSeek.com/v1", "d", { ...D, maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" }],
  ["https://llm.chutes.ai/v1", "c", { ...D, maxTokensField: "max_tokens" }],
  ["https://opencode.ai/zen/v1", "o", { ...D }],
  ["https://api.cloudflare.com/client/v4/accounts/a/ai/v1", "c", { ...D, supportsLongCacheRetention: false }],
  ["https://gateway.ai.cloudflare.com/v1/a/b/openai", "c", { ...D, supportsReasoningEffort: false, maxTokensField: "max_tokens", supportsStrictMode: false, supportsLongCacheRetention: false }],
  ["https://integrate.api.nvidia.com/v1", "n", { ...D, supportsReasoningEffort: false, maxTokensField: "max_tokens", supportsStrictMode: false, supportsLongCacheRetention: false }],
  ["https://api.ant-ling.com/v1", "a", { ...D, supportsReasoningEffort: false, maxTokensField: "max_tokens", thinkingFormat: "ant-ling", supportsLongCacheRetention: false }],
  ["https://open.bigmodel.cn/api/paas/v4", "g", { ...D, supportsReasoningEffort: false, maxTokensField: "max_tokens", thinkingFormat: "zai" }],
];

for (const [url, id, want] of HOST_TABLE) {
  test(`table: ${new URL(url).hostname}`, () => {
    assert.deepEqual(piCompatFor(url, id), want);
  });
}

test("a host pi has no rule for gets null", () => {
  assert.equal(piCompatFor("https://api.example.com/v1", "m1"), null);
  assert.equal(piCompatFor("not a url", "m1"), null);
  assert.equal(piCompatFor("", "m1"), null);
});

// --- Crow-side known upstream quirks (pi has no rule for these) --------------
// Alibaba Cloud Model Studio / DashScope rejects a `developer` message role
// with HTTP 400, and pi 0.85.1 knows nothing about the host, so the door entry
// must turn the flag off itself.
test("quirk: Alibaba Cloud Model Studio hosts get supportsDeveloperRole: false", () => {
  for (const url of [
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "https://aliyuncs.com/compatible-mode/v1",
    // Fully-qualified form: one trailing dot is not part of the name.
    "https://dashscope.aliyuncs.com./compatible-mode/v1",
    "https://aliyuncs.com./compatible-mode/v1",
    "https://DASHSCOPE-INTL.Aliyuncs.COM/compatible-mode/v1",
  ]) {
    assert.deepEqual(piCompatFor(url, "qwen3.8-max"), { supportsDeveloperRole: false }, url);
  }
});

test("quirk: lookalike hosts and paths are not Alibaba", () => {
  for (const url of [
    "https://aliyuncs.com.evil.example/v1",
    "https://notaliyuncs.com/v1",
    "https://api.example.com/proxy/aliyuncs.com/compatible-mode/v1",
    "https://api.example.com/v1?upstream=dashscope.aliyuncs.com",
  ]) {
    assert.equal(piCompatFor(url, "qwen3.8-max"), null, url);
  }
  // An unparseable baseUrl behaves as before: pi's own substring rules only.
  assert.equal(piCompatFor("aliyuncs.com/compatible-mode/v1", "m"), null);
});

test("quirk: pi's own rules are unchanged by the quirk table", () => {
  assert.deepEqual(piCompatFor("https://api.deepseek.com/v1", "deepseek-chat"), {
    supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens",
    requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek",
  });
  const or = piCompatFor("https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5.5");
  assert.equal(or.thinkingFormat, "openrouter");
  assert.equal("supportsDeveloperRole" in or, false, "an OpenRouter anthropic/ id keeps the developer role");
  assert.equal(piCompatFor("https://api.z.ai/api/coding/paas/v4", "glm-5.3").thinkingFormat, "zai");
});

// Drift check: the pinned list must equal the installed pi-ai registry when
// the installed pi is the pinned version. Skipped (with the reason) otherwise.
function findPinnedInstall() {
  const PKG = join("@earendil-works", "pi-coding-agent");
  const roots = [];
  const r = resolvePiCli();
  if (r) roots.push(resolve(dirname(r.cliPath), ".."));
  const nvm = join(homedir(), ".nvm", "versions", "node");
  if (existsSync(nvm)) {
    for (const v of readdirSync(nvm)) roots.push(join(nvm, v, "lib", "node_modules", PKG));
  }
  const seen = [];
  for (const root of roots) {
    const pj = join(root, "package.json");
    if (!existsSync(pj)) continue;
    let version;
    try { version = JSON.parse(readFileSync(pj, "utf8")).version; } catch { continue; }
    seen.push(version);
    if (version !== PI_PINNED_VERSION) continue;
    for (const ai of [
      join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js"),
      join(root, "..", "pi-ai", "dist", "providers", "all.js"),
    ]) {
      if (existsSync(ai)) return { allJs: ai, root, seen };
    }
  }
  return { allJs: null, seen };
}

test("drift: PI_BUILTIN_PROVIDER_IDS equals the installed pi-ai registry", async (t) => {
  const { allJs, seen } = findPinnedInstall();
  if (!allJs) {
    const why = seen.length ? `installed pi versions ${seen.join(", ")}, none is ${PI_PINNED_VERSION}` : "pi is not installed";
    console.log(`[pi-compat] drift check skipped: ${why}`);
    t.skip(why);
    return;
  }
  const { builtinProviders } = await import(pathToFileURL(allJs).href);
  assert.deepEqual([...PI_BUILTIN_PROVIDER_IDS], builtinProviders().map((p) => p.id));
});

// Live check: pull detectCompat out of the installed openai-completions chunk
// and confirm that "what pi derives through the door" merged with
// piCompatFor equals what pi derives talking to the upstream directly.
// Crow's own quirks (KNOWN_UPSTREAM_QUIRKS: an aliyuncs.com host) are
// deliberately NOT in these cases: there piCompatFor must differ from pi — the
// check at the bottom of this file pins that difference.
const DOOR = { provider: "crow-door", baseUrl: "http://127.0.0.1:3001/llm/c/cloud-a/v1" };
const LIVE_CASES = [
  ["https://api.z.ai/api/coding/paas/v4", "glm-5.3"],
  ["https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5.5"],
  ["https://openrouter.ai/api/v1", "openai/gpt-5"],
  ["https://openrouter.ai/api/v1", "qwen/qwen3-max"],
  ["https://api.deepseek.com/v1", "deepseek-chat"],
  ["https://api.together.xyz/v1", "m"],
  ["https://api.moonshot.ai/v1", "kimi-k2"],
  ["https://api.x.ai/v1", "grok-4"],
  ["https://api.cerebras.ai/v1", "m"],
  ["https://api.example.com/v1", "m1"],
  ...HOST_TABLE.map(([u, id]) => [u, id]),
];

// Pull the installed pi's detectCompat out of the openai-completions chunk and
// hand it back as a function. On no pinned install, returns `{ why }` for the
// caller to skip with, exactly as the checks below always have.
function installedDetectCompat() {
  const { allJs, root: piRoot, seen } = findPinnedInstall();
  if (!allJs) {
    return { why: seen.length ? `installed pi versions ${seen.join(", ")}, none is ${PI_PINNED_VERSION}` : "pi is not installed" };
  }
  const chunks = join(piRoot, "dist", "bundle", "chunks");
  const file = readdirSync(chunks).find((n) => /^openai-completions-.*\.js$/.test(n));
  assert.ok(file, "the openai-completions chunk exists in the pinned install");
  const src = readFileSync(join(chunks, file), "utf8");
  const i = src.indexOf("function detectCompat(model)");
  const j = src.indexOf("function getCompat(model)");
  assert.ok(i >= 0 && j > i, "detectCompat and getCompat are where 0.85.1 has them");
  // eslint-disable-next-line no-new-func
  return { detectCompat: new Function(`${src.slice(i, j)}; return detectCompat;`)() };
}

test("live: piCompatFor reproduces the installed detectCompat for every case", (t) => {
  const { detectCompat, why } = installedDetectCompat();
  if (!detectCompat) {
    console.log(`[pi-compat] live detectCompat check skipped: ${why}`);
    t.skip(why);
    return;
  }
  const viaDoor = detectCompat({ ...DOOR, id: "m" });
  for (const [url, id] of LIVE_CASES) {
    const provider = url.includes("openrouter.ai") ? "openrouter" : "crow-door";
    const upstream = detectCompat({ provider, baseUrl: url, id });
    assert.deepEqual({ ...viaDoor, ...(piCompatFor(url, id) || {}) }, upstream, `${url} ${id}`);
  }
});

// The quirk's premise: pi 0.85.1 has NO aliyuncs.com rule, so the installed
// detectCompat keeps the developer role on for that host. If a future pi adds
// its own rule, this fails — that is the signal to drop the Crow table entry
// (and this case) rather than carry a duplicate.
const ALIBABA_URLS = [
  "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
];

test("live: the installed detectCompat has no aliyuncs rule of its own", (t) => {
  const { detectCompat, why } = installedDetectCompat();
  if (!detectCompat) {
    console.log(`[pi-compat] live detectCompat quirk check skipped: ${why}`);
    t.skip(why);
    return;
  }
  for (const url of ALIBABA_URLS) {
    const upstream = detectCompat({ provider: "crow-door", baseUrl: url, id: "qwen3.8-max" });
    assert.equal(upstream.supportsDeveloperRole, true, `${url}: pi keeps the developer role, so the quirk is still ours to carry`);
    // …and Crow's quirk is the only thing that turns it off.
    assert.equal(piCompatFor(url, "qwen3.8-max")?.supportsDeveloperRole, false, url);
  }
});

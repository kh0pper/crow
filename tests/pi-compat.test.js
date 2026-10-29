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

test("live: piCompatFor reproduces the installed detectCompat for every case", (t) => {
  const { allJs, root: piRoot, seen } = findPinnedInstall();
  if (!allJs) {
    const why = seen.length ? `installed pi versions ${seen.join(", ")}, none is ${PI_PINNED_VERSION}` : "pi is not installed";
    console.log(`[pi-compat] live detectCompat check skipped: ${why}`);
    t.skip(why);
    return;
  }
  const chunks = join(piRoot, "dist", "bundle", "chunks");
  const file = readdirSync(chunks).find((n) => /^openai-completions-.*\.js$/.test(n));
  assert.ok(file, "the openai-completions chunk exists in the pinned install");
  const src = readFileSync(join(chunks, file), "utf8");
  const i = src.indexOf("function detectCompat(model)");
  const j = src.indexOf("function getCompat(model)");
  assert.ok(i >= 0 && j > i, "detectCompat and getCompat are where 0.85.1 has them");
  // eslint-disable-next-line no-new-func
  const detectCompat = new Function(`${src.slice(i, j)}; return detectCompat;`)();
  const viaDoor = detectCompat({ ...DOOR, id: "m" });
  for (const [url, id] of LIVE_CASES) {
    const provider = url.includes("openrouter.ai") ? "openrouter" : "crow-door";
    const upstream = detectCompat({ provider, baseUrl: url, id });
    assert.deepEqual({ ...viaDoor, ...(piCompatFor(url, id) || {}) }, upstream, `${url} ${id}`);
  }
});

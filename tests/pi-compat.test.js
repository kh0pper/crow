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
      if (existsSync(ai)) return { allJs: ai, seen };
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

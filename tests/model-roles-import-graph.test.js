/**
 * Model roles import hygiene (I4): the binding store never loads the consumer
 * scan, the smart-router or the seed, and voice-bot.js stays a no-import leaf.
 * Each target is imported in a child node with a resolve hook recording every
 * URL the loader resolves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");

function importedUrls(relPath) {
  const target = pathToFileURL(join(ROOT, relPath)).href;
  const script = `
    import { registerHooks } from "node:module";
    const seen = [];
    registerHooks({ resolve(s, c, n) { const r = n(s, c); seen.push(r.url); return r; } });
    await import(${JSON.stringify(target)});
    process.stdout.write(JSON.stringify(seen));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  return { target, seen: JSON.parse(String(out)) };
}

test("model-roles-store.js loads neither the consumer scan, the smart-router nor the seed", () => {
  const { seen } = importedUrls("servers/shared/model-roles-store.js");
  assert.ok(seen.length > 1, "the hook recorded the import graph");
  for (const banned of ["servers/shared/model-consumers.js", "servers/gateway/ai/smart-router.js", "servers/shared/model-roles-seed.js"]) {
    const hit = seen.filter((u) => u.endsWith(banned));
    assert.equal(hit.length, 0, `store must not load ${banned}`);
  }
});

test("voice-bot.js loads nothing besides itself", () => {
  const { target, seen } = importedUrls("servers/shared/voice-bot.js");
  const others = seen.filter((u) => u !== target);
  assert.equal(others.length, 0, `voice-bot.js imported ${others.length} other module(s)`);
});

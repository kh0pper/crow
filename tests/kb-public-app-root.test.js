// The public KB pages import the gateway's shared modules (legacy design
// tokens, the markdown renderer, the db helpers). From an INSTALLED copy
// (~/.crow/bundles/knowledge-base) a path relative to this file points into
// ~/.crow, not the app, so the pages rendered unstyled. They must resolve the
// app root through the bundle's app-root helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(repo, "bundles/knowledge-base/routes/kb-public.js"), "utf8");

test("kb-public resolves shared modules from APP_ROOT, not a path relative to itself", () => {
  assert.match(src, /import \{ APP_ROOT \} from "\.\.\/server\/app-root\.js";/);
  assert.match(src, /const repoRoot = APP_ROOT;/);
  assert.doesNotMatch(src, /const repoRoot = resolve\(__dirname/);
});

test("from an installed copy outside the repo, APP_ROOT still finds the legacy design tokens", async () => {
  const home = mkdtempSync(join(tmpdir(), "kb-approot-"));
  try {
    const dest = join(home, ".crow", "bundles", "knowledge-base");
    cpSync(join(repo, "bundles/knowledge-base/server"), join(dest, "server"), { recursive: true });
    const prev = process.env.CROW_APP_ROOT;
    process.env.CROW_APP_ROOT = repo;
    try {
      const { APP_ROOT } = await import(pathToFileURL(join(dest, "server", "app-root.js")).href + "?t=" + Date.now());
      assert.equal(APP_ROOT, repo);
      await import(pathToFileURL(join(APP_ROOT, "servers/gateway/dashboard/shared/design-tokens-legacy.js")).href);
    } finally {
      if (prev === undefined) delete process.env.CROW_APP_ROOT; else process.env.CROW_APP_ROOT = prev;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
